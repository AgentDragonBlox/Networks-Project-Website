#!/usr/bin/env python3
"""correlate: join application measurements with the SDN controller's view of the network.

Reads a results folder written by multipath.py --auto:

    runs.json            which runs were made (route policy, files)
    probe_<run>.json     netprobe measurements (RTT, jitter, loss, lost packets)
    topology_<run>.json  the controller's export at that moment (links, hosts, paths)

and reports:
    1. the discovered SDN topology and every alternative path between the hosts
    2. the measured delay, jitter and loss of each path the traffic took
    3. which links explain the differences between paths (correlation)
    4. failed paths and how long traffic was interrupted before rerouting
    5. the best path

Usage:  python3 correlate.py results/   (also writes results/report.txt and report.json)
"""

import json
import os
import sys

LOSS_WEIGHT_MS = 10.0  # ranking: each 1% of loss counts like 10 ms of extra delay


def load(folder, name):
    with open(os.path.join(folder, name)) as f:
        return json.load(f)


def conversation_path(topology, src, dst):
    """Switch path the controller reports for src->dst (falls back to dst->src reversed)."""
    paths = topology.get("paths", {})
    if f"{src}->{dst}" in paths:
        return paths[f"{src}->{dst}"]["switches"]
    if f"{dst}->{src}" in paths:
        return list(reversed(paths[f"{dst}->{src}"]["switches"]))
    return None


def links_of(path):
    return {"-".join(sorted(pair)) for pair in zip(path, path[1:])} if path else set()


def score(stats):
    if not stats["received"]:
        return float("inf")
    return stats["avg_ms"] + LOSS_WEIGHT_MS * stats["loss_pct"]


def status(stats, best_avg):
    if not stats["received"]:
        return "FAILED"
    if stats["loss_pct"] >= 5:
        return "LOSSY"
    if best_avg and stats["avg_ms"] > 2 * best_avg + 5:
        return "SLOW"
    return "OK"


def outages(lost_seq, interval):
    """Runs of consecutive lost probes: [(first_seq, last_seq, seconds)]."""
    spans = []
    for seq in lost_seq:
        if spans and seq == spans[-1][1] + 1:
            spans[-1][1] = seq
        else:
            spans.append([seq, seq])
    return [(a, b, round((b - a + 1) * interval, 2)) for a, b in spans]


def analyse(folder):
    meta = load(folder, "runs.json")
    src, dst = meta["src"], meta["dst"]
    runs = []
    for r in meta["runs"]:
        probe = load(folder, r["probe"])
        topo = load(folder, r["topology"]) if os.path.exists(os.path.join(folder, r["topology"])) else {}
        runs.append({**r, "stats": probe["stats"], "interval": probe.get("interval", 0.05),
                     "path": conversation_path(topo, src, dst), "topology": topo})

    steady = [r for r in runs if not r.get("event")]
    ranked = sorted(steady, key=lambda r: score(r["stats"]))
    best = ranked[0] if ranked else None
    best_avg = best["stats"]["avg_ms"] if best else None

    for r in runs:
        r["status"] = status(r["stats"], best_avg)
        r["explained_by"] = None
        if best and r is not best and r["path"] and best["path"]:
            extra = links_of(r["path"]) - links_of(best["path"])
            delta = (r["stats"]["avg_ms"] or 0) - best_avg if r["stats"]["received"] else None
            loss_delta = r["stats"]["loss_pct"] - best["stats"]["loss_pct"]
            r["explained_by"] = {"links": sorted(extra), "extra_ms": round(delta, 2) if delta is not None else None,
                                 "extra_loss_pct": round(loss_delta, 2)}

    first_topo = next((r["topology"] for r in runs if r["topology"]), {})
    last_topo = next((r["topology"] for r in reversed(runs) if r["topology"]), {})
    failover = next((r for r in runs if r.get("event")), None)
    failure = None
    if failover:
        before = next((r["path"] for r in runs if r["name"] == "auto"), None)
        failure = {
            "event": failover["event"],
            "failed_links": failover["topology"].get("failed_links", []),
            "failed_paths": failover["topology"].get("failed_paths", []),
            "path_before": before,
            "path_after": failover["path"],
            "outages": outages(failover["stats"].get("lost_seq", []), failover["interval"]),
            "loss_pct": failover["stats"]["loss_pct"],
        }
    return {"src": src, "dst": dst, "topology": first_topo, "final_topology": last_topo, "runs": runs,
            "ranking": [r["name"] for r in ranked], "best": best["name"] if best else None, "failure": failure}


def fmt(v, unit=""):
    return "-" if v is None else f"{v:.2f}{unit}"


def path_str(path, src, dst):
    return " -> ".join([src] + path + [dst]) if path else "(no path reported)"


def render(a):
    src, dst = a["src"], a["dst"]
    t = a["topology"]
    out = ["NETPATH SDN CORRELATION REPORT", "=" * 30, ""]

    out.append("1. Discovered SDN topology (from the POX controller)")
    out.append(f"   switches: {', '.join(t.get('switches', [])) or '-'}")
    out.append("   links:    " + (", ".join(f"{l['a']}-{l['b']}" for l in t.get("links", [])) or "-"))
    for h in t.get("hosts", []):
        if h.get("ip"):
            out.append(f"   host {h['ip']:<10} on {h['switch']} port {h['port']}")
    alts = t.get("alternatives", {}).get(f"{src}->{dst}") or t.get("alternatives", {}).get(f"{dst}->{src}") or []
    out.append(f"   alternative paths {src} -> {dst}: {len(alts)}")
    for p in alts:
        out.append(f"     {' -> '.join(p)}")
    out.append("")

    out.append("2. Measurements per path (netprobe, UDP)")
    out.append(f"   {'run':<15}{'path':<38}{'avg ms':>8}{'jitter':>8}{'loss %':>8}  status")
    for r in a["runs"]:
        s = r["stats"]
        out.append(f"   {r['name']:<15}{path_str(r['path'], src, dst):<38}{fmt(s['avg_ms']):>8}{fmt(s['jitter_ms']):>8}"
                   f"{s['loss_pct']:>8.1f}  {r['status']}")
    out.append("")

    out.append("3. Correlation: which links explain the differences")
    best = next((r for r in a["runs"] if r["name"] == a["best"]), None)
    if best:
        out.append(f"   baseline: {a['best']} via {path_str(best['path'], src, dst)}")
    for r in a["runs"]:
        e = r["explained_by"]
        if not e or r.get("event") or not e["links"]:
            continue
        parts = []
        if e["extra_ms"] is not None and abs(e["extra_ms"]) >= 1:
            parts.append(f"{e['extra_ms']:+.1f} ms")
        if e["extra_loss_pct"] >= 1:
            parts.append(f"{e['extra_loss_pct']:+.1f}% loss")
        if parts:
            out.append(f"   {r['name']}: {' and '.join(parts)} vs baseline, from links {', '.join(e['links'])}")
    out.append("")

    out.append("4. Failed paths")
    f = a["failure"]
    if not f:
        out.append("   none tested")
    else:
        out.append(f"   event: {f['event']}")
        for l in f["failed_links"]:
            out.append(f"   controller saw link {l['link']} fail ({l['reason']})")
        for p in f["failed_paths"]:
            out.append(f"   failed path for {p['conversation']}: {' -> '.join(p['path'])} (used {p['link']})")
        out.append(f"   path before: {path_str(f['path_before'], src, dst)}")
        out.append(f"   path after:  {path_str(f['path_after'], src, dst)}")
        if f["outages"]:
            longest = max(f["outages"], key=lambda o: o[2])
            out.append(f"   traffic interrupted for about {longest[2]} s (probes {longest[0]}-{longest[1]} lost), "
                       f"{f['loss_pct']}% loss over the run")
        else:
            out.append("   no probes lost: rerouting was hitless")
    out.append("")

    out.append("5. Recommendation")
    if best:
        out.append(f"   best path: {path_str(best['path'], src, dst)} "
                   f"({fmt(best['stats']['avg_ms'], ' ms')}, {best['stats']['loss_pct']}% loss)")
        out.append(f"   ranking (delay + {LOSS_WEIGHT_MS:.0f} ms per 1% loss): {', '.join(a['ranking'])}")
    return "\n".join(out)


def main(argv=None):
    argv = argv if argv is not None else sys.argv[1:]
    if len(argv) != 1:
        print("usage: correlate.py RESULTS_FOLDER")
        return 2
    folder = argv[0]
    a = analyse(folder)
    text = render(a)
    print(text)
    with open(os.path.join(folder, "report.txt"), "w") as fh:
        fh.write(text + "\n")
    slim = {k: v for k, v in a.items() if k not in ("topology", "final_topology")}
    slim["runs"] = [{k: v for k, v in r.items() if k != "topology"} for r in a["runs"]]
    with open(os.path.join(folder, "report.json"), "w") as fh:
        json.dump(slim, fh, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
