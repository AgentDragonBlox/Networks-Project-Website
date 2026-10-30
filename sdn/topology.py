#!/usr/bin/env python3
"""NetPath SDN lab: a Mininet network for testing the traceroute and path-analysis tool.

    h1 ─ s1 ─ r1 ─ s2 ─ r2 ─ s3 ─ r3 ─ s4 ─ h2
                              ▲           ▲
                   +60 ms RTT long-haul   lossy last mile

* s1–s4 are Open vSwitch switches with no forwarding logic of their own: every
  forwarding decision comes from the POX controller (netpath_controller.py).
* r1–r3 are Linux hosts with IP forwarding turned on. They are the routers that
  traceroute sees as hops. OpenFlow switches work at layer 2 and never decrement
  the TTL, so without routers the whole path would look like a single hop.
* The s3–r3 link adds 30 ms each way (+60 ms round trip at hop 3) and the s4–h2
  link drops packets, so path analysis has a latency jump and partial loss to find.

Run (POX must already be running, see README.md):

    sudo python3 topology.py                       # interactive Mininet CLI
    sudo python3 topology.py --auto --tool ~/network-diagnostics-and-path-analysis-tool
"""

import argparse
import os
from functools import partial

from mininet.cli import CLI
from mininet.link import TCLink
from mininet.log import info, setLogLevel
from mininet.net import Mininet
from mininet.node import Node, OVSSwitch, RemoteController
from mininet.topo import Topo

H2_IP = "10.0.4.2"


class LinuxRouter(Node):
    """A host that forwards IP packets between its interfaces, i.e. a router."""

    def config(self, **params):
        super().config(**params)
        self.cmd("sysctl -w net.ipv4.ip_forward=1")

    def terminate(self):
        self.cmd("sysctl -w net.ipv4.ip_forward=0")
        super().terminate()


class NetPathTopo(Topo):
    """Two hosts, three routers and four SDN switches in a line, one subnet per segment."""

    def build(self, delay_ms=30, loss_pct=15):
        h1 = self.addHost("h1", ip="10.0.1.2/24", defaultRoute="via 10.0.1.1")
        h2 = self.addHost("h2", ip=f"{H2_IP}/24", defaultRoute="via 10.0.4.1")
        r1 = self.addHost("r1", cls=LinuxRouter, ip="10.0.1.1/24")
        r2 = self.addHost("r2", cls=LinuxRouter, ip="10.0.2.2/24")
        r3 = self.addHost("r3", cls=LinuxRouter, ip="10.0.3.2/24")
        # fixed datapath ids so the controller can recognise s4 (the "firewall" switch)
        s1, s2, s3, s4 = (self.addSwitch(f"s{i}", dpid=f"{i:016x}") for i in range(1, 5))

        fast = {"delay": "1ms"}
        # segment 10.0.1.0/24: h1 ─ s1 ─ r1
        self.addLink(h1, s1, **fast)
        self.addLink(r1, s1, intfName1="r1-eth0", params1={"ip": "10.0.1.1/24"}, **fast)
        # segment 10.0.2.0/24: r1 ─ s2 ─ r2
        self.addLink(r1, s2, intfName1="r1-eth1", params1={"ip": "10.0.2.1/24"}, **fast)
        self.addLink(r2, s2, intfName1="r2-eth0", params1={"ip": "10.0.2.2/24"}, **fast)
        # segment 10.0.3.0/24: r2 ─ s3 ─ r3, with the long-haul delay on s3–r3
        self.addLink(r2, s3, intfName1="r2-eth1", params1={"ip": "10.0.3.1/24"}, **fast)
        self.addLink(r3, s3, intfName1="r3-eth0", params1={"ip": "10.0.3.2/24"}, delay=f"{delay_ms}ms")
        # segment 10.0.4.0/24: r3 ─ s4 ─ h2, with packet loss on the last mile
        self.addLink(r3, s4, intfName1="r3-eth1", params1={"ip": "10.0.4.1/24"}, **fast)
        self.addLink(h2, s4, delay="1ms", loss=loss_pct)


def add_routes(net):
    """Static routes so every router can reach every subnet."""
    routes = {
        "r1": ["10.0.3.0/24 via 10.0.2.2", "10.0.4.0/24 via 10.0.2.2"],
        "r2": ["10.0.1.0/24 via 10.0.2.1", "10.0.4.0/24 via 10.0.3.2"],
        "r3": ["10.0.1.0/24 via 10.0.3.1", "10.0.2.0/24 via 10.0.3.1"],
    }
    for router, entries in routes.items():
        for entry in entries:
            net[router].cmd(f"ip route add {entry}")


def run_tool(net, tool_dir, results_dir):
    """From h1 to h2: our socket-based UDP traceroute and probe, then the system traceroute
    and the project's path analysis for comparison. Every output is saved."""
    os.makedirs(results_dir, exist_ok=True)
    h1, h2 = net["h1"], net["h2"]
    netprobe = os.path.join(os.path.dirname(os.path.abspath(__file__)), "netprobe.py")
    h2.cmd(f"python3 '{netprobe}' server > /tmp/netprobe_server.log 2>&1 &")
    steps = [
        ("netprobe_trace.txt",
         f"python3 '{netprobe}' trace {H2_IP} --tool '{tool_dir}' --json '{results_dir}/netprobe_trace.json'"),
        ("netprobe_probe.txt",
         f"python3 '{netprobe}' probe {H2_IP} --count 100 --interval 0.02 --json '{results_dir}/netprobe_probe.json'"),
        ("traceroute.txt", f"traceroute -n -q 3 -w 2 {H2_IP}"),
        ("path_analysis.txt", f"cd '{tool_dir}' && python3 -m path_analysis {H2_IP}"),
    ]
    for filename, command in steps:
        info(f"\n*** h1$ {command}\n")
        output = h1.cmd(command)
        info(output)
        with open(os.path.join(results_dir, filename), "w") as f:
            f.write(output)
    info(f"\n*** Saved to {results_dir}/ (paste traceroute.txt into the website's parser playground)\n")


def main():
    parser = argparse.ArgumentParser(description="NetPath SDN lab (Mininet + POX)")
    parser.add_argument("--controller", default="127.0.0.1", help="POX address (default 127.0.0.1)")
    parser.add_argument("--port", type=int, default=6633, help="POX OpenFlow port (default 6633)")
    parser.add_argument("--delay", type=int, default=30, help="one-way delay of the long-haul link in ms")
    parser.add_argument("--loss", type=int, default=15, help="packet loss on the last-mile link in percent")
    parser.add_argument("--auto", action="store_true", help="run traceroute and path analysis from h1, then open the CLI")
    # under sudo, "~" is root's home, so look in the invoking user's home instead
    home = os.path.expanduser("~" + os.environ.get("SUDO_USER", ""))
    parser.add_argument("--tool", default=os.path.join(home, "network-diagnostics-and-path-analysis-tool"),
                        help="folder of the network-diagnostics-and-path-analysis-tool repo")
    parser.add_argument("--no-cli", action="store_true", help="exit after --auto instead of opening the CLI")
    args = parser.parse_args()

    setLogLevel("info")
    net = Mininet(
        topo=NetPathTopo(delay_ms=args.delay, loss_pct=args.loss),
        controller=partial(RemoteController, ip=args.controller, port=args.port),
        switch=partial(OVSSwitch, protocols="OpenFlow10"),  # POX speaks OpenFlow 1.0
        link=TCLink,
        autoSetMacs=True,
    )
    net.start()
    add_routes(net)
    info("\n*** Path: h1 10.0.1.2 → r1 → r2 → r3 → h2 10.0.4.2\n")
    info(f"*** Long-haul link s3–r3: {args.delay} ms each way · last-mile loss s4–h2: {args.loss}%\n")
    info("*** Try: h1 traceroute -n h2   |   h1 ping -c 4 h2   |   pingall\n")

    if args.auto:
        run_tool(net, args.tool, os.path.join(os.path.dirname(os.path.abspath(__file__)), "results"))
    if not (args.auto and args.no_cli):
        CLI(net)
    net.stop()


if __name__ == "__main__":
    main()
