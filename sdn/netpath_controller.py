"""NetPath SDN controller: a POX component that runs every switch in the lab network.

What it does:
1. Discovers the SDN topology: switches (OpenFlow connections), the links between
   them (LLDP, via openflow.discovery) and where each host is attached.
2. Routes every conversation over a chosen path of switches and installs the
   OpenFlow rules along it. The route policy can be changed live:
       auto         fewest switches (ties go to the lowest switch ids)
       via N        the shortest path through switch sN
       path A B C   exactly this switch path
   written to the policy file (default /tmp/netpath_route).
3. Detects failed links (port down or LLDP timeout), records which active paths
   used them, and reroutes traffic over an alternative path.
4. Firewall switch: while the flag file exists, the firewall switch drops IPv4
   traffic to the protected hosts. Traceroute then never reaches them.
5. Exports its view of the network to /tmp/netpath_topology.json (switches, links,
   hosts, the path each conversation uses, every alternative path, failed paths),
   which correlate.py joins with the measurements from netprobe.py.

Install and run (see README.md):

    cp netpath_controller.py netpath_graph.py ~/pox/ext/
    cd ~/pox && ./pox.py log.level --INFO openflow.discovery \\
        openflow.spanning_tree --no-flood --hold-down netpath_controller

openflow.spanning_tree keeps broadcasts (ARP) from looping in topologies with
alternative paths. Options (all optional):

    --firewall_switch=4                  switch that enforces the firewall
    --protected=10.0.4.2,10.0.0.2        IPs the firewall protects
    --flag=/tmp/netpath_firewall         touch to block, delete to unblock
    --route_file=/tmp/netpath_route      route policy file
    --export=/tmp/netpath_topology.json  topology export
"""

import json
import os
import time

import pox.openflow.libopenflow_01 as of
from pox.core import core
from pox.lib.addresses import IPAddr
from pox.lib.recoco import Timer

from netpath_graph import candidate_paths, choose_path, parse_policy, ports_along, uses_link

log = core.getLogger()

IDLE_TIMEOUT = 20  # seconds a path flow survives without traffic
HARD_TIMEOUT = 60  # seconds before a path is recomputed regardless
LLDP_TYPE = 0x88CC


def sname(dpid):
    return "s%d" % dpid


class NetPathController(object):
    def __init__(self, firewall_dpid, protected, flag_path, route_file, export_path):
        self.firewall_dpid = firewall_dpid
        self.protected = set(protected)
        self.flag_path = flag_path
        self.route_file = route_file
        self.export_path = export_path

        self.switches = {}  # dpid -> connection
        self.links = set()  # {(a, a_port, b, b_port)} with a < b, links that are up
        self.hosts = {}  # mac -> {"dpid", "port", "ip"}
        self.active = {}  # (src_mac, dst_mac) -> {"path": [...], "policy": str, "since": t}
        self.failed_links = []  # [{"link": "s2-s4", "at": t, "reason": str}]
        self.failed_paths = []  # [{"conversation": ..., "path": [...], "link": ..., "at": t}]

        self.firewall_on = os.path.exists(flag_path)
        self.policy_text = self._read_policy()
        self.policy = parse_policy(self.policy_text)

        core.openflow.addListeners(self)
        core.openflow_discovery.addListenerByName("LinkEvent", self._handle_LinkEvent)
        Timer(1, self._poll_files, recurring=True)
        Timer(2, self._export, recurring=True)
        log.info("NetPath controller ready, policy '%s', firewall %s on s%s for %s",
                 self.policy_text, "ON" if self.firewall_on else "off", firewall_dpid, ", ".join(protected))

    # ------------------------------------------------------------ topology discovery

    def _handle_ConnectionUp(self, event):
        self.switches[event.dpid] = event.connection
        log.info("switch %s connected", sname(event.dpid))

    def _handle_ConnectionDown(self, event):
        self.switches.pop(event.dpid, None)
        self.links = {l for l in self.links if event.dpid not in (l[0], l[2])}
        log.warning("switch %s disconnected", sname(event.dpid))
        self._reroute_all("switch %s down" % sname(event.dpid))

    def _handle_LinkEvent(self, event):
        l = event.link.uni
        key = (l.dpid1, l.port1, l.dpid2, l.port2)
        if event.added and key not in self.links:
            self.links.add(key)
            # A port that turned out to face another switch is not a host port.
            for mac, h in list(self.hosts.items()):
                if (h["dpid"], h["port"]) in ((l.dpid1, l.port1), (l.dpid2, l.port2)):
                    del self.hosts[mac]
            log.info("link up %s-%s", sname(l.dpid1), sname(l.dpid2))
            self._reroute_all("link %s-%s up" % (sname(l.dpid1), sname(l.dpid2)))
        elif event.removed and key in self.links:
            self._link_failed(key, "LLDP timeout")

    def _handle_PortStatus(self, event):
        down = event.deleted or bool(event.ofp.desc.state & of.OFPPS_LINK_DOWN)
        if not down:
            return
        for key in [l for l in self.links if (l[0], l[1]) == (event.dpid, event.port) or (l[2], l[3]) == (event.dpid, event.port)]:
            self._link_failed(key, "port %s.%s down" % (sname(event.dpid), event.port))

    def _link_failed(self, key, reason):
        self.links.discard(key)
        name = "%s-%s" % (sname(key[0]), sname(key[2]))
        now = time.time()
        self.failed_links.append({"link": name, "at": now, "reason": reason})
        for conv, info in self.active.items():
            if uses_link(info["path"], key[0], key[2]):
                self.failed_paths.append({"conversation": self._conv_name(conv), "path": [sname(d) for d in info["path"]],
                                          "link": name, "at": now})
        log.warning("link FAILED %s (%s)", name, reason)
        self._reroute_all("link %s failed" % name)

    # ------------------------------------------------------------ forwarding

    def _handle_PacketIn(self, event):
        packet = event.parsed
        if not packet.parsed or packet.type == LLDP_TYPE:
            return
        dpid, in_port = event.dpid, event.port
        edge = core.openflow_discovery.is_edge_port(dpid, in_port)

        if edge and not packet.src.is_multicast:
            host = self.hosts.setdefault(packet.src, {"dpid": dpid, "port": in_port, "ip": None})
            host["dpid"], host["port"] = dpid, in_port
            arp = packet.find("arp")
            if arp is not None and arp.protosrc != IPAddr("0.0.0.0"):
                host["ip"] = arp.protosrc  # the sender's own address, never a forwarded one

        ip = packet.find("ipv4")
        if ip is not None and self._blocked(dpid, ip.dstip):
            self._send_flow(event.connection, of.ofp_match.from_packet(packet, in_port), [], event.ofp)
            log.warning("%s DROP %s -> %s (firewall on)", sname(dpid), ip.srcip, ip.dstip)
            return

        dst = self.hosts.get(packet.dst)
        if packet.dst.is_multicast or dst is None:
            self._flood(event)  # spanning tree keeps this loop-free
            return

        if dst["dpid"] == dpid and dst["port"] == in_port:
            return  # destination is back where the frame came from: drop it

        candidates = candidate_paths(self.links, dpid, dst["dpid"])
        path = choose_path(candidates, self.policy)
        if path is None:
            log.warning("no path %s -> %s for %s", sname(dpid), sname(dst["dpid"]), packet.dst)
            return

        hops = ports_along(self.links, path, dst["port"])
        match = of.ofp_match(dl_src=packet.src, dl_dst=packet.dst)
        # Install from the far end back, so the packet never overtakes its own rules.
        for hop_dpid, out_port in reversed(hops[1:]):
            conn = self.switches.get(hop_dpid)
            if conn is not None:
                self._send_flow(conn, match, [of.ofp_action_output(port=out_port)])
        self._send_flow(event.connection, match, [of.ofp_action_output(port=hops[0][1])], event.ofp)

        conv = (packet.src, packet.dst)
        if self.active.get(conv, {}).get("path") != path:
            log.info("path %s: %s  (policy %s)", self._conv_name(conv), " -> ".join(sname(d) for d in path), self.policy_text)
        self.active[conv] = {"path": path, "policy": self.policy_text, "since": time.time()}

    def _send_flow(self, connection, match, actions, data=None):
        msg = of.ofp_flow_mod()
        msg.match = match
        msg.idle_timeout = IDLE_TIMEOUT
        msg.hard_timeout = HARD_TIMEOUT
        msg.actions = actions  # no actions = drop
        if data is not None:
            msg.data = data  # also release the packet that triggered this rule
        connection.send(msg)

    def _flood(self, event):
        msg = of.ofp_packet_out()
        msg.actions.append(of.ofp_action_output(port=of.OFPP_FLOOD))
        msg.data = event.ofp
        msg.in_port = event.port
        event.connection.send(msg)

    def _blocked(self, dpid, dst_ip):
        return self.firewall_on and dpid == self.firewall_dpid and str(dst_ip) in self.protected

    def _reroute_all(self, why):
        """Delete every installed flow; the next packets are routed again under the current state."""
        for conn in self.switches.values():
            conn.send(of.ofp_flow_mod(command=of.OFPFC_DELETE))
        self.active.clear()
        log.info("flows cleared (%s)", why)
        self._export()

    # ------------------------------------------------------------ live controls

    def _read_policy(self):
        try:
            with open(self.route_file) as f:
                return f.read().strip() or "auto"
        except IOError:
            return "auto"

    def _poll_files(self):
        on = os.path.exists(self.flag_path)
        if on != self.firewall_on:
            self.firewall_on = on
            log.warning("firewall turned %s", "ON" if on else "off")
            self._reroute_all("firewall changed")
        text = self._read_policy()
        if text != self.policy_text:
            self.policy_text, self.policy = text, parse_policy(text)
            log.warning("route policy now '%s'", text)
            self._reroute_all("route policy changed")

    # ------------------------------------------------------------ export

    def _conv_name(self, conv):
        def name(mac):
            h = self.hosts.get(mac)
            return str(h["ip"]) if h and h["ip"] else str(mac)
        return "%s->%s" % (name(conv[0]), name(conv[1]))

    def _export(self):
        hosts = [{"mac": str(m), "ip": str(h["ip"]) if h["ip"] else None, "switch": sname(h["dpid"]), "port": h["port"]}
                 for m, h in sorted(self.hosts.items(), key=lambda kv: str(kv[0]))]
        paths, alternatives = {}, {}
        for conv, info in self.active.items():
            name = self._conv_name(conv)
            paths[name] = {"switches": [sname(d) for d in info["path"]], "policy": info["policy"], "since": info["since"]}
            dst = self.hosts.get(conv[1])
            src = self.hosts.get(conv[0])
            if src and dst:
                alternatives[name] = [[sname(d) for d in p] for p in candidate_paths(self.links, src["dpid"], dst["dpid"])]
        data = {
            "time": time.time(),
            "policy": self.policy_text,
            "firewall": {"on": self.firewall_on, "switch": sname(self.firewall_dpid), "protected": sorted(self.protected)},
            "switches": sorted(sname(d) for d in self.switches),
            "links": [{"a": sname(a), "a_port": ap, "b": sname(b), "b_port": bp} for a, ap, b, bp in sorted(self.links)],
            "hosts": hosts,
            "paths": paths,
            "alternatives": alternatives,
            "failed_links": self.failed_links,
            "failed_paths": self.failed_paths,
        }
        tmp = self.export_path + ".tmp"
        try:
            with open(tmp, "w") as f:
                json.dump(data, f, indent=2)
            os.replace(tmp, self.export_path)
        except (IOError, OSError) as exc:
            log.error("could not write %s: %s", self.export_path, exc)


def launch(firewall_switch="4", protected="10.0.4.2,10.0.0.2", flag="/tmp/netpath_firewall",
           route_file="/tmp/netpath_route", export="/tmp/netpath_topology.json"):
    """./pox.py openflow.discovery openflow.spanning_tree --no-flood --hold-down netpath_controller [options]"""
    def start():
        core.registerNew(NetPathController, int(firewall_switch), [p.strip() for p in protected.split(",") if p.strip()],
                         flag, route_file, export)
    core.call_when_ready(start, ["openflow", "openflow_discovery"])
