#!/usr/bin/env python3
"""NetPath multipath lab: three alternative paths through an SDN, measured and compared.

                ┌─ s2 ─┐   path A: fast (2 ms links)
    h1 ── s1 ───┼─ s3 ─┼─── s4 ── h2
                └─ s5 ─┘   path B: slow (20 ms links) · path C: fast but lossy (s5–s4)

* POX (netpath_controller.py) discovers the switches and links, decides which
  path every conversation takes, and exports that view of the network.
* netprobe.py measures delay, jitter and loss with its own UDP probes.
* correlate.py joins the two: which path the traffic took, what it measured,
  which links explain the difference, which paths failed.

Run (POX must already be running, see README.md):

    sudo python3 multipath.py            # interactive Mininet CLI
    sudo python3 multipath.py --auto     # measure every path, fail a link, write the report
    sudo python3 multipath.py --serve    # let the website's SDN Lab page drive the lab
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from mininet.cli import CLI
from mininet.link import TCLink
from mininet.log import info, setLogLevel
from mininet.net import Mininet
from mininet.node import OVSSwitch, RemoteController
from mininet.topo import Topo

import correlate

HERE = os.path.dirname(os.path.abspath(__file__))
NETPROBE = os.path.join(HERE, "netprobe.py")
ROUTE_FILE = "/tmp/netpath_route"
TOPOLOGY_FILE = "/tmp/netpath_topology.json"
FIREWALL_FLAG = "/tmp/netpath_firewall"
H1_IP, H2_IP = "10.0.0.1", "10.0.0.2"
LAB_PORT = 8765
POLICIES = [("auto", "auto"), ("path-A-via-s2", "via 2"), ("path-B-via-s3", "via 3"), ("path-C-via-s5", "via 5")]
POLICY_RE = re.compile(r"^(auto|via \d+|path( \d+)+)$")
# the switch-to-switch links, as built in MultipathTopo below
LINK_INFO = {
    ("s1", "s2"): {"delay_ms": 2, "loss_pct": 0, "path": "A"},
    ("s2", "s4"): {"delay_ms": 2, "loss_pct": 0, "path": "A"},
    ("s1", "s3"): {"delay_ms": 20, "loss_pct": 0, "path": "B"},
    ("s3", "s4"): {"delay_ms": 20, "loss_pct": 0, "path": "B"},
    ("s1", "s5"): {"delay_ms": 2, "loss_pct": 0, "path": "C"},
    ("s5", "s4"): {"delay_ms": 2, "loss_pct": 10, "path": "C"},
}
SWITCH_LINKS = list(LINK_INFO)


class MultipathTopo(Topo):
    def build(self, slow_ms=20, loss_pct=10):
        h1 = self.addHost("h1", ip=f"{H1_IP}/24")
        h2 = self.addHost("h2", ip=f"{H2_IP}/24")
        s1, s2, s3, s4, s5 = (self.addSwitch(f"s{i}", dpid=f"{i:016x}") for i in range(1, 6))
        self.addLink(h1, s1, delay="1ms")
        self.addLink(h2, s4, delay="1ms")
        # path A: fast
        self.addLink(s1, s2, delay="2ms")
        self.addLink(s2, s4, delay="2ms")
        # path B: slow
        self.addLink(s1, s3, delay=f"{slow_ms}ms")
        self.addLink(s3, s4, delay=f"{slow_ms}ms")
        # path C: fast, but its last link drops packets
        self.addLink(s1, s5, delay="2ms")
        self.addLink(s5, s4, delay="2ms", loss=loss_pct)


def set_policy(text):
    with open(ROUTE_FILE, "w") as f:
        f.write(text + "\n")


def snapshot(dest):
    """Copy the controller's latest topology export next to the measurements."""
    time.sleep(2.5)  # the controller exports every 2 s
    if os.path.exists(TOPOLOGY_FILE):
        shutil.copy(TOPOLOGY_FILE, dest)
    else:
        info(f"*** {TOPOLOGY_FILE} not found: is netpath_controller running?\n")


def probe(h1, out, count=60, interval=0.05, label=""):
    cmd = f"python3 '{NETPROBE}' probe {H2_IP} --count {count} --interval {interval} --label {label} --json '{out}'"
    info(f"h1$ {cmd}\n")
    info(h1.cmd(cmd))


def prepare(net):
    """Let POX discover the topology and learn the hosts, then start the UDP echo server on h2."""
    info("*** Waiting for the controller to discover the topology (LLDP)…\n")
    time.sleep(12)
    net.pingAll(timeout="1")  # lets the controller learn where h1 and h2 are
    net["h2"].cmd(f"python3 '{NETPROBE}' server > /tmp/netprobe_server.log 2>&1 &")
    time.sleep(1)


def measure_paths(net, results, count=60, policies=POLICIES):
    """Force each path in turn with a route policy and measure it. Returns the runs."""
    runs = []
    for name, policy in policies:
        info(f"\n*** Route policy '{policy}'\n")
        set_policy(policy)
        time.sleep(3)  # controller polls the policy file every second and clears old flows
        probe(net["h1"], os.path.join(results, f"probe_{name}.json"), count=count, label=name)
        snapshot(os.path.join(results, f"topology_{name}.json"))
        runs.append({"name": name, "policy": policy, "probe": f"probe_{name}.json", "topology": f"topology_{name}.json"})
    return runs


def failover(net, results):
    """Probe on the auto path for 15 s and take link s2-s4 down 4 s in. Returns the run."""
    info("\n*** Failure test: probing on the auto path while link s2-s4 goes down\n")
    set_policy("auto")
    time.sleep(3)
    out = os.path.join(results, "probe_failover.json")
    net["h1"].cmd(f"python3 '{NETPROBE}' probe {H2_IP} --count 300 --interval 0.05 --label failover "
                  f"--json '{out}' > /dev/null 2>&1 &")
    time.sleep(4)
    net.configLinkStatus("s2", "s4", "down")
    info("*** link s2-s4 DOWN\n")
    time.sleep(13)  # let the 15 s probe finish
    snapshot(os.path.join(results, "topology_failover.json"))
    net.configLinkStatus("s2", "s4", "up")
    info("*** link s2-s4 restored\n")
    return {"name": "failover", "policy": "auto", "probe": "probe_failover.json", "topology": "topology_failover.json",
            "event": "link s2-s4 taken down 4 s into the run"}


def write_runs(results, runs):
    with open(os.path.join(results, "runs.json"), "w") as f:
        json.dump({"src": H1_IP, "dst": H2_IP, "runs": runs}, f, indent=2)


def auto(net, results):
    os.makedirs(results, exist_ok=True)
    prepare(net)
    runs = measure_paths(net, results)
    runs.append(failover(net, results))
    write_runs(results, runs)
    info("\n*** Correlating measurements with the SDN topology\n")
    report = subprocess.run([sys.executable, os.path.join(HERE, "correlate.py"), results], capture_output=True, text=True)
    info(report.stdout + report.stderr)


class Lab:
    """What the website can do to the running lab. One action at a time: Mininet's
    node.cmd() is not thread-safe, so every action holds the lock."""

    def __init__(self, net, results):
        self.net, self.results = net, results
        self.lock = threading.Lock()
        self.busy = None  # name of the running action
        self.links = {pair: True for pair in SWITCH_LINKS}
        self.policy = "auto"
        self.started = time.time()

    def status(self):
        return {"lab": "multipath", "busy": self.busy, "policy": self.policy,
                "firewall": os.path.exists(FIREWALL_FLAG), "started": self.started,
                "hosts": {"h1": H1_IP, "h2": H2_IP},
                "links": [{"a": a, "b": b, "up": up, **LINK_INFO[(a, b)]} for (a, b), up in self.links.items()]}

    def run(self, name, fn, *args):
        if not self.lock.acquire(blocking=False):
            raise Busy(self.busy)
        self.busy = name
        try:
            return fn(*args)
        finally:
            self.busy = None
            self.lock.release()

    def set_route(self, policy):
        policy = " ".join(str(policy).split())
        if not POLICY_RE.match(policy):
            raise ValueError("policy must be 'auto', 'via N' or 'path A B C'")
        set_policy(policy)
        self.policy = policy
        return self.status()

    def set_firewall(self, on):
        if on:
            open(FIREWALL_FLAG, "w").close()
        elif os.path.exists(FIREWALL_FLAG):
            os.remove(FIREWALL_FLAG)
        return self.status()

    def set_link(self, a, b, up):
        pair = (a, b) if (a, b) in self.links else (b, a)
        if pair not in self.links:
            raise ValueError(f"no switch link {a}-{b} in this lab")
        self.net.configLinkStatus(pair[0], pair[1], "up" if up else "down")
        self.links[pair] = bool(up)
        return self.status()

    def probe(self, count, interval):
        count = max(1, min(int(count), 500))
        interval = max(0.01, min(float(interval), 1.0))
        out = os.path.join(self.results, "probe_web.json")
        cmd = (f"python3 '{NETPROBE}' probe {H2_IP} --count {count} --interval {interval} "
               f"--label web --json '{out}'")
        text = self.net["h1"].cmd(cmd)
        with open(out) as f:
            measured = json.load(f)
        time.sleep(2.5)  # wait for the controller's next export, so the path matches this run
        return {"command": f"h1$ {cmd.replace(NETPROBE, 'netprobe.py')}", "output": text,
                "probe": measured, "topology": read_json(TOPOLOGY_FILE)}

    def compare(self, count):
        runs = measure_paths(self.net, self.results, count=max(10, min(int(count), 200)))
        set_policy(self.policy)  # put back what the user had chosen
        return self._correlate(runs)

    def failover(self):
        runs = measure_paths(self.net, self.results, count=40, policies=POLICIES[:1])  # the auto baseline
        runs.append(failover(self.net, self.results))
        self.links[("s2", "s4")] = True
        set_policy(self.policy)
        return self._correlate(runs)

    def _correlate(self, runs):
        write_runs(self.results, runs)
        analysis = correlate.analyse(self.results)
        return {"report": correlate.render(analysis), "analysis": correlate.slim(analysis)}


class Busy(Exception):
    pass


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def serve(lab, port):
    """Lab control API for the website. serve.py forwards /api/lab/* here; localhost only."""

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            info(f"*** web: {fmt % args}\n")

        def reply(self, code, data):
            body = json.dumps(data).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path.rstrip("/") == "/status":
                self.reply(200, lab.status())
            else:
                self.reply(404, {"error": "not found"})

        def do_POST(self):
            try:
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}") if length else {}
                actions = {
                    "/route": lambda: lab.run("route", lab.set_route, body.get("policy", "")),
                    "/firewall": lambda: lab.run("firewall", lab.set_firewall, bool(body.get("on"))),
                    "/link": lambda: lab.run("link", lab.set_link, str(body.get("a")), str(body.get("b")),
                                             bool(body.get("up"))),
                    "/probe": lambda: lab.run("probe", lab.probe, body.get("count", 50), body.get("interval", 0.05)),
                    "/compare": lambda: lab.run("compare", lab.compare, body.get("count", 40)),
                    "/failover": lambda: lab.run("failover", lab.failover),
                }
                action = actions.get(self.path.rstrip("/"))
                if not action:
                    return self.reply(404, {"error": "not found"})
                self.reply(200, action())
            except Busy as e:
                self.reply(409, {"error": f"the lab is busy ({e})"})
            except (ValueError, TypeError) as e:
                self.reply(400, {"error": str(e)})
            except Exception as e:  # report it to the page rather than drop the connection
                self.reply(500, {"error": f"{type(e).__name__}: {e}"})

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    info(f"\n*** Lab control API on http://127.0.0.1:{port}  (open the website's SDN Lab page; Ctrl+C stops)\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def main():
    parser = argparse.ArgumentParser(description="NetPath multipath SDN lab (Mininet + POX)")
    parser.add_argument("--controller", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=6633)
    parser.add_argument("--slow", type=int, default=20, help="one-way delay of each path-B link in ms")
    parser.add_argument("--loss", type=int, default=10, help="packet loss on the s5-s4 link in percent")
    parser.add_argument("--auto", action="store_true", help="measure all paths, fail a link and write the report")
    parser.add_argument("--no-cli", action="store_true", help="exit after --auto")
    parser.add_argument("--serve", action="store_true",
                        help=f"run the lab control API on 127.0.0.1:{LAB_PORT} for the website, instead of the CLI")
    parser.add_argument("--serve-port", type=int, default=LAB_PORT)
    args = parser.parse_args()
    for (a, b), link in LINK_INFO.items():  # keep what the website shows in step with the options
        if link["path"] == "B":
            link["delay_ms"] = args.slow
        if (a, b) == ("s5", "s4"):
            link["loss_pct"] = args.loss

    setLogLevel("info")
    set_policy("auto")
    net = Mininet(
        topo=MultipathTopo(slow_ms=args.slow, loss_pct=args.loss),
        controller=partial(RemoteController, ip=args.controller, port=args.port),
        switch=partial(OVSSwitch, protocols="OpenFlow10"),
        link=TCLink,
        autoSetMacs=True,
    )
    net.start()
    info("\n*** Paths h1 -> h2: A s1-s2-s4 (fast) | B s1-s3-s4 (slow) | C s1-s5-s4 (lossy)\n")
    info(f"*** Change the route live: echo 'via 3' > {ROUTE_FILE}   (or 'auto', 'via 2', 'via 5')\n")
    info("*** Measure: h1 python3 netprobe.py probe 10.0.0.2   (start 'h2 python3 netprobe.py server &' first)\n")
    results = os.path.join(HERE, "results")
    if args.serve:
        os.makedirs(results, exist_ok=True)
        prepare(net)
        serve(Lab(net, results), args.serve_port)
    else:
        if args.auto:
            auto(net, results)
        if not (args.auto and args.no_cli):
            CLI(net)
    net.stop()


if __name__ == "__main__":
    main()
