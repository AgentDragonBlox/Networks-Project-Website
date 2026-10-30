#!/usr/bin/env python3
"""netprobe: a socket-based UDP diagnostic tool.

Measures delay, packet loss and path characteristics with our own UDP probes,
built directly on the socket API (no ping or traceroute programs involved).

    netprobe.py server [--port 9000]
        UDP echo server: sends every probe straight back to its sender.

    netprobe.py probe HOST [--port 9000] [--count 50] [--interval 0.05] [--json out.json]
        Sends numbered, timestamped UDP datagrams to the server and measures
        round-trip time (min/avg/max), jitter, packet loss, reordering and duplicates.

    netprobe.py trace HOST [--max-hops 30] [--queries 3] [--json out.json] [--tool DIR]
        UDP traceroute built on sockets: sends UDP datagrams with TTL 1, 2, 3 …
        and listens on a raw ICMP socket for "time exceeded" (a router on the
        path) and "port unreachable" (the destination). Needs root on Linux/macOS.
        With --tool, the hops are handed to the project's path_analysis module.

Every mode can write JSON, which correlate.py joins with the SDN controller's
view of the topology.
"""

import argparse
import json
import os
import select
import socket
import struct
import sys
import time

MAGIC = b"NPRB"
HEADER = struct.Struct("!4sIQ")  # magic, sequence number, send time (ns)
DEFAULT_PORT = 9000
TRACE_BASE_PORT = 33434  # the traditional traceroute port range


# --------------------------------------------------------------------------- statistics

def summarize(sent, rtts_ms, duplicates=0, reordered=0):
    """Delay and loss statistics for one probe run.

    sent      number of probes sent
    rtts_ms   RTT of each probe that came back, in arrival order (ms)
    """
    received = len(rtts_ms)
    stats = {
        "sent": sent,
        "received": received,
        "loss_pct": round(100.0 * (sent - received) / sent, 2) if sent else 100.0,
        "duplicates": duplicates,
        "reordered": reordered,
        "min_ms": None,
        "avg_ms": None,
        "max_ms": None,
        "stdev_ms": None,
        "jitter_ms": None,
    }
    if rtts_ms:
        avg = sum(rtts_ms) / received
        stats["min_ms"] = round(min(rtts_ms), 3)
        stats["avg_ms"] = round(avg, 3)
        stats["max_ms"] = round(max(rtts_ms), 3)
        stats["stdev_ms"] = round((sum((r - avg) ** 2 for r in rtts_ms) / received) ** 0.5, 3)
        # jitter as in RFC 3550: mean absolute difference between consecutive RTTs
        diffs = [abs(b - a) for a, b in zip(rtts_ms, rtts_ms[1:])]
        stats["jitter_ms"] = round(sum(diffs) / len(diffs), 3) if diffs else 0.0
    return stats


def make_probe(seq, size):
    packet = HEADER.pack(MAGIC, seq, time.perf_counter_ns())
    return packet + b"\x00" * max(0, size - len(packet))


def parse_probe(data):
    if len(data) < HEADER.size:
        return None
    magic, seq, sent_ns = HEADER.unpack_from(data)
    return (seq, sent_ns) if magic == MAGIC else None


# --------------------------------------------------------------------------- server

def run_server(bind, port):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((bind, port))
    print(f"netprobe server listening on udp://{bind}:{port}", flush=True)
    while True:
        data, addr = sock.recvfrom(65535)
        if parse_probe(data) is not None:
            sock.sendto(data, addr)


# --------------------------------------------------------------------------- probe

def run_probe(host, port, count, interval, timeout, size):
    """Send `count` UDP probes and collect the echoes. Returns (stats, samples)."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setblocking(False)
    target = (socket.gethostbyname(host), port)
    seen = set()
    rtts = []
    samples = []  # (seq, rtt_ms or None)
    duplicates = reordered = 0
    highest = -1
    next_send = time.perf_counter()
    sent = 0
    deadline = None

    def receive(wait):
        nonlocal duplicates, reordered, highest
        ready, _, _ = select.select([sock], [], [], max(0.0, wait))
        if not ready:
            return
        while True:
            try:
                data, _ = sock.recvfrom(65535)
            except (BlockingIOError, ConnectionResetError):
                # Windows reports ICMP port unreachable as a reset on the next recv
                return
            now = time.perf_counter_ns()
            parsed = parse_probe(data)
            if parsed is None:
                continue
            seq, sent_ns = parsed
            if seq in seen:
                duplicates += 1
                continue
            if seq < highest:
                reordered += 1
            highest = max(highest, seq)
            seen.add(seq)
            rtt = (now - sent_ns) / 1e6
            rtts.append(rtt)
            samples.append((seq, round(rtt, 3)))

    while True:
        now = time.perf_counter()
        if sent < count and now >= next_send:
            try:
                sock.sendto(make_probe(sent, size), target)
            except OSError:
                pass  # unreachable network: counts as lost
            sent += 1
            next_send += interval
            if sent == count:
                deadline = time.perf_counter() + timeout
        if deadline is not None and time.perf_counter() >= deadline:
            break
        wake = next_send if sent < count else deadline
        receive(wake - time.perf_counter())

    sock.close()
    lost = sorted(set(range(count)) - seen)
    stats = summarize(count, rtts, duplicates, reordered)
    stats["lost_seq"] = lost
    return stats, samples


# --------------------------------------------------------------------------- trace

def run_trace(host, max_hops, queries, timeout, base_port):
    """UDP traceroute on raw sockets. Returns a list of hops in path_analysis's dict format."""
    dest = socket.gethostbyname(host)
    try:
        icmp = socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP)
    except PermissionError:
        sys.exit("trace needs a raw ICMP socket: run it as root (sudo), or inside Mininet")
    udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    hops = []
    probe_id = 0
    for ttl in range(1, max_hops + 1):
        udp.setsockopt(socket.IPPROTO_IP, socket.IP_TTL, ttl)
        hop = {"hop": ttl, "ip": None, "rtts": []}
        reached = False
        for _ in range(queries):
            port = base_port + probe_id
            probe_id += 1
            start = time.perf_counter()
            udp.sendto(b"netprobe", (dest, port))
            rtt = None
            while True:
                left = timeout - (time.perf_counter() - start)
                if left <= 0:
                    break
                ready, _, _ = select.select([icmp], [], [], left)
                if not ready:
                    break
                packet, (addr, _) = icmp.recvfrom(1024)
                answer = parse_icmp_reply(packet)
                if answer is None or answer[1] != port:
                    continue  # someone else's ICMP, keep waiting
                rtt = (time.perf_counter() - start) * 1000
                hop["ip"] = hop["ip"] or addr
                if answer[0] == "unreachable" and addr == dest:
                    reached = True
                break
            hop["rtts"].append(round(rtt, 3) if rtt is not None else None)
        hops.append(hop)
        if reached:
            break
    return dest, hops


def parse_icmp_reply(packet):
    """('time_exceeded' | 'unreachable', original UDP destination port) or None."""
    ihl = (packet[0] & 0x0F) * 4
    icmp_type, icmp_code = packet[ihl], packet[ihl + 1]
    if icmp_type == 11:
        kind = "time_exceeded"
    elif icmp_type == 3 and icmp_code == 3:
        kind = "unreachable"
    else:
        return None
    inner = packet[ihl + 8:]  # the original IP header + first 8 bytes of our UDP header
    if len(inner) < 20:
        return None
    inner_ihl = (inner[0] & 0x0F) * 4
    if len(inner) < inner_ihl + 4:
        return None
    dport = struct.unpack("!H", inner[inner_ihl + 2:inner_ihl + 4])[0]
    return kind, dport


def analyze_with_tool(tool_dir, hops, target, reached):
    """Hand the hops to the project's path_analysis module when it is available."""
    sys.path.insert(0, os.path.abspath(os.path.expanduser(tool_dir)))
    try:
        from path_analysis.analyzer import analyze_path, summary
    except ImportError as exc:
        return f"(path_analysis not found in {tool_dir}: {exc})"
    stats, bottlenecks = analyze_path(hops)
    return summary(stats, bottlenecks, target, reached)


# --------------------------------------------------------------------------- CLI

def main(argv=None):
    p = argparse.ArgumentParser(description="Socket-based UDP network diagnostics")
    sub = p.add_subparsers(dest="mode", required=True)

    s = sub.add_parser("server", help="UDP echo server")
    s.add_argument("--bind", default="0.0.0.0")
    s.add_argument("--port", type=int, default=DEFAULT_PORT)

    c = sub.add_parser("probe", help="measure RTT, jitter and loss to a netprobe server")
    c.add_argument("host")
    c.add_argument("--port", type=int, default=DEFAULT_PORT)
    c.add_argument("--count", type=int, default=50)
    c.add_argument("--interval", type=float, default=0.05, help="seconds between probes")
    c.add_argument("--timeout", type=float, default=1.0, help="seconds to wait for late echoes")
    c.add_argument("--size", type=int, default=64, help="datagram size in bytes")
    c.add_argument("--label", default="", help="name for this run in the JSON")
    c.add_argument("--json", help="write the results to this file")

    t = sub.add_parser("trace", help="UDP traceroute on raw sockets (root)")
    t.add_argument("host")
    t.add_argument("--max-hops", type=int, default=30)
    t.add_argument("--queries", type=int, default=3)
    t.add_argument("--timeout", type=float, default=2.0)
    t.add_argument("--port", type=int, default=TRACE_BASE_PORT)
    t.add_argument("--tool", help="network-diagnostics-and-path-analysis-tool folder, for path analysis")
    t.add_argument("--json", help="write the hops to this file")

    a = p.parse_args(argv)

    if a.mode == "server":
        run_server(a.bind, a.port)
        return 0

    if a.mode == "probe":
        stats, samples = run_probe(a.host, a.port, a.count, a.interval, a.timeout, a.size)
        result = {"mode": "probe", "label": a.label, "target": a.host, "port": a.port, "time": time.time(),
                  "count": a.count, "interval": a.interval, "stats": stats, "samples": samples}
        f = lambda v: "-" if v is None else f"{v:.2f}"
        print(f"netprobe {a.host}:{a.port}  {stats['sent']} sent, {stats['received']} received, "
              f"{stats['loss_pct']}% loss, {stats['reordered']} reordered, {stats['duplicates']} duplicates")
        print(f"rtt min/avg/max/stdev = {f(stats['min_ms'])}/{f(stats['avg_ms'])}/{f(stats['max_ms'])}/"
              f"{f(stats['stdev_ms'])} ms   jitter = {f(stats['jitter_ms'])} ms")
    else:
        dest, hops = run_trace(a.host, a.max_hops, a.queries, a.timeout, a.port)
        reached = bool(hops) and hops[-1]["ip"] == dest
        result = {"mode": "trace", "target": a.host, "destination": dest, "reached": reached,
                  "time": time.time(), "hops": hops}
        for h in hops:
            rtts = "  ".join("*" if r is None else f"{r:.2f} ms" for r in h["rtts"])
            print(f"{h['hop']:>2}  {h['ip'] or '*':<16} {rtts}")
        print(f"destination {dest}: {'reached' if reached else 'NOT reached'}")
        if a.tool:
            print()
            print(analyze_with_tool(a.tool, hops, a.host, reached))

    if a.json:
        with open(a.json, "w") as fh:
            json.dump(result, fh, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
