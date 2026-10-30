"""Tests for the UDP probe tool: statistics, ICMP parsing and a real loopback run."""

import os
import socket
import struct
import sys
import threading
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import netprobe  # noqa: E402


def free_udp_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class Summarize(unittest.TestCase):
    def test_loss_and_rtt(self):
        s = netprobe.summarize(4, [10.0, 12.0, 11.0])
        self.assertEqual(s["received"], 3)
        self.assertEqual(s["loss_pct"], 25.0)
        self.assertEqual(s["min_ms"], 10.0)
        self.assertEqual(s["max_ms"], 12.0)
        self.assertEqual(s["avg_ms"], 11.0)
        # RFC 3550-style jitter: mean of |12-10| and |11-12|
        self.assertEqual(s["jitter_ms"], 1.5)

    def test_nothing_back(self):
        s = netprobe.summarize(5, [])
        self.assertEqual(s["loss_pct"], 100.0)
        self.assertIsNone(s["avg_ms"])


class IcmpParsing(unittest.TestCase):
    @staticmethod
    def icmp(type_, code, dport):
        outer_ip = bytes([0x45]) + bytes(19)
        inner_ip = bytes([0x45]) + bytes(19)
        inner_udp = struct.pack("!HHHH", 50000, dport, 16, 0)
        return outer_ip + bytes([type_, code]) + bytes(6) + inner_ip + inner_udp

    def test_time_exceeded(self):
        self.assertEqual(netprobe.parse_icmp_reply(self.icmp(11, 0, 33435)), ("time_exceeded", 33435))

    def test_port_unreachable(self):
        self.assertEqual(netprobe.parse_icmp_reply(self.icmp(3, 3, 33440)), ("unreachable", 33440))

    def test_other_icmp_ignored(self):
        self.assertIsNone(netprobe.parse_icmp_reply(self.icmp(0, 0, 1)))


class Loopback(unittest.TestCase):
    """Real UDP sockets on 127.0.0.1: an echo server thread and the probe client."""

    def test_probe_against_server(self):
        port = free_udp_port()
        threading.Thread(target=netprobe.run_server, args=("127.0.0.1", port), daemon=True).start()
        stats, samples = netprobe.run_probe("127.0.0.1", port, count=30, interval=0.005, timeout=0.5, size=64)
        self.assertEqual(stats["sent"], 30)
        self.assertEqual(stats["received"], 30)
        self.assertEqual(stats["loss_pct"], 0.0)
        self.assertEqual(len(samples), 30)
        self.assertLess(stats["avg_ms"], 100)

    def test_probe_with_no_server_is_total_loss(self):
        stats, _ = netprobe.run_probe("127.0.0.1", free_udp_port(), count=5, interval=0.005, timeout=0.3, size=64)
        self.assertEqual(stats["received"], 0)
        self.assertEqual(stats["loss_pct"], 100.0)
        self.assertEqual(stats["lost_seq"], [0, 1, 2, 3, 4])


if __name__ == "__main__":
    unittest.main()
