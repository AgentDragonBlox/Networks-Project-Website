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
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from functools import partial

from mininet.cli import CLI
from mininet.link import TCLink
from mininet.log import info, setLogLevel
from mininet.net import Mininet
from mininet.node import OVSSwitch, RemoteController
from mininet.topo import Topo

HERE = os.path.dirname(os.path.abspath(__file__))
NETPROBE = os.path.join(HERE, "netprobe.py")
ROUTE_FILE = "/tmp/netpath_route"
TOPOLOGY_FILE = "/tmp/netpath_topology.json"
H1_IP, H2_IP = "10.0.0.1", "10.0.0.2"


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


def auto(net, results):
    os.makedirs(results, exist_ok=True)
    h1, h2 = net["h1"], net["h2"]
    info("*** Waiting for the controller to discover the topology (LLDP)…\n")
    time.sleep(12)
    net.pingAll(timeout="1")  # lets the controller learn where h1 and h2 are
    h2.cmd(f"python3 '{NETPROBE}' server > /tmp/netprobe_server.log 2>&1 &")
    time.sleep(1)

    runs = []
    for name, policy in [("auto", "auto"), ("path-A-via-s2", "via 2"), ("path-B-via-s3", "via 3"), ("path-C-via-s5", "via 5")]:
        info(f"\n*** Route policy '{policy}'\n")
        set_policy(policy)
        time.sleep(3)  # controller polls the policy file every second and clears old flows
        probe(h1, os.path.join(results, f"probe_{name}.json"), label=name)
        snapshot(os.path.join(results, f"topology_{name}.json"))
        runs.append({"name": name, "policy": policy, "probe": f"probe_{name}.json", "topology": f"topology_{name}.json"})

    info("\n*** Failure test: probing on the auto path while link s2-s4 goes down\n")
    set_policy("auto")
    time.sleep(3)
    out = os.path.join(results, "probe_failover.json")
    h1.cmd(f"python3 '{NETPROBE}' probe {H2_IP} --count 300 --interval 0.05 --label failover --json '{out}' > /dev/null 2>&1 &")
    time.sleep(4)
    net.configLinkStatus("s2", "s4", "down")
    info("*** link s2-s4 DOWN\n")
    time.sleep(13)  # let the 15 s probe finish
    snapshot(os.path.join(results, "topology_failover.json"))
    runs.append({"name": "failover", "policy": "auto", "probe": "probe_failover.json", "topology": "topology_failover.json",
                 "event": "link s2-s4 taken down 4 s into the run"})
    net.configLinkStatus("s2", "s4", "up")
    info("*** link s2-s4 restored\n")

    with open(os.path.join(results, "runs.json"), "w") as f:
        json.dump({"src": H1_IP, "dst": H2_IP, "runs": runs}, f, indent=2)
    info("\n*** Correlating measurements with the SDN topology\n")
    report = subprocess.run([sys.executable, os.path.join(HERE, "correlate.py"), results], capture_output=True, text=True)
    info(report.stdout + report.stderr)


def main():
    parser = argparse.ArgumentParser(description="NetPath multipath SDN lab (Mininet + POX)")
    parser.add_argument("--controller", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=6633)
    parser.add_argument("--slow", type=int, default=20, help="one-way delay of each path-B link in ms")
    parser.add_argument("--loss", type=int, default=10, help="packet loss on the s5-s4 link in percent")
    parser.add_argument("--auto", action="store_true", help="measure all paths, fail a link and write the report")
    parser.add_argument("--no-cli", action="store_true", help="exit after --auto")
    args = parser.parse_args()

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
    if args.auto:
        auto(net, os.path.join(HERE, "results"))
    if not (args.auto and args.no_cli):
        CLI(net)
    net.stop()


if __name__ == "__main__":
    main()
