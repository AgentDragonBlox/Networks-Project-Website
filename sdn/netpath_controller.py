"""NetPath SDN controller: a POX component that runs every switch in the lab network.

What it does:
1. Learning switch: learns which port each MAC address is on and installs
   OpenFlow 1.0 flow rules, so later packets are forwarded by the switch itself.
2. Firewall switch: while the flag file exists, the "firewall" switch (s4 by
   default) installs drop rules for IPv4 traffic to the protected host (h2).
   Traceroute then still sees r1, r2 and r3 but never reaches h2, the same as
   the website's "destination behind a firewall" scenario, done here with an
   SDN rule instead of a firewall box.
3. Logging: every new flow and every firewall change is logged, so you can
   show the controller making decisions live.

Install and run (see README.md):

    cp netpath_controller.py ~/pox/ext/
    cd ~/pox && ./pox.py log.level --INFO netpath_controller

Options (all optional):

    --firewall_switch=4           datapath id of the switch that enforces the block
    --protected=10.0.4.2          IP address the firewall protects
    --flag=/tmp/netpath_firewall  touch this file to block, delete it to unblock
"""

import os

import pox.openflow.libopenflow_01 as of
from pox.core import core
from pox.lib.addresses import IPAddr
from pox.lib.recoco import Timer
from pox.lib.util import dpid_to_str

log = core.getLogger()

IDLE_TIMEOUT = 10  # seconds a learned flow survives without traffic
HARD_TIMEOUT = 30  # seconds before a flow is re-learned regardless


class SwitchHandler(object):
    """Learning-switch logic for one connected switch."""

    def __init__(self, connection, app):
        self.connection = connection
        self.app = app
        self.dpid = connection.dpid
        self.mac_to_port = {}
        connection.addListeners(self)

    def _handle_PacketIn(self, event):
        packet = event.parsed
        if not packet.parsed:
            return
        in_port = event.port
        self.mac_to_port[packet.src] = in_port

        ip = packet.find("ipv4")
        if ip is not None and self.app.should_block(self.dpid, ip):
            self._install_drop(packet, in_port, ip)
            return

        if packet.dst.is_multicast or packet.dst not in self.mac_to_port:
            self._flood(event)
            return

        out_port = self.mac_to_port[packet.dst]
        if out_port == in_port:
            return  # would bounce back where it came from: drop it

        msg = of.ofp_flow_mod()
        msg.match = of.ofp_match.from_packet(packet, in_port)
        msg.idle_timeout = IDLE_TIMEOUT
        msg.hard_timeout = HARD_TIMEOUT
        msg.actions.append(of.ofp_action_output(port=out_port))
        msg.data = event.ofp  # also forward the packet that triggered this rule
        self.connection.send(msg)
        log.info("s%s flow  %s → %s  port %s → %s", self.dpid, packet.src, packet.dst, in_port, out_port)

    def _flood(self, event):
        msg = of.ofp_packet_out()
        msg.actions.append(of.ofp_action_output(port=of.OFPP_FLOOD))
        msg.data = event.ofp
        msg.in_port = event.port
        self.connection.send(msg)

    def _install_drop(self, packet, in_port, ip):
        # A flow rule with no actions drops matching packets in the switch.
        msg = of.ofp_flow_mod()
        msg.match = of.ofp_match.from_packet(packet, in_port)
        msg.idle_timeout = IDLE_TIMEOUT
        msg.hard_timeout = HARD_TIMEOUT
        self.connection.send(msg)
        log.warning("s%s DROP  %s → %s (firewall on)", self.dpid, ip.srcip, ip.dstip)


class NetPathController(object):
    """Tracks connected switches and the firewall flag."""

    def __init__(self, firewall_dpid, protected_ip, flag_path):
        self.firewall_dpid = firewall_dpid
        self.protected_ip = protected_ip
        self.flag_path = flag_path
        self.firewall_on = os.path.exists(flag_path)
        core.openflow.addListeners(self)
        Timer(1, self._check_flag, recurring=True)
        log.info(
            "NetPath controller ready · firewall switch s%s protects %s · firewall %s (flag file %s)",
            firewall_dpid, protected_ip, "ON" if self.firewall_on else "off", flag_path,
        )

    def _handle_ConnectionUp(self, event):
        log.info("switch s%s connected (%s)", event.dpid, dpid_to_str(event.dpid))
        SwitchHandler(event.connection, self)

    def should_block(self, dpid, ip):
        return self.firewall_on and dpid == self.firewall_dpid and ip.dstip == self.protected_ip

    def _check_flag(self):
        on = os.path.exists(self.flag_path)
        if on == self.firewall_on:
            return
        self.firewall_on = on
        log.warning("firewall turned %s, clearing flow tables so the new policy applies", "ON" if on else "off")
        # Delete every installed flow; switches ask the controller again and get the new policy.
        for connection in core.openflow.connections:
            connection.send(of.ofp_flow_mod(command=of.OFPFC_DELETE))


def launch(firewall_switch="4", protected="10.0.4.2", flag="/tmp/netpath_firewall"):
    """Entry point: ./pox.py netpath_controller [--firewall_switch=4] [--protected=10.0.4.2] [--flag=...]"""
    core.registerNew(NetPathController, int(firewall_switch), IPAddr(protected), flag)
