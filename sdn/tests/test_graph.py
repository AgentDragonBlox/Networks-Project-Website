"""Tests for the controller's path logic (no POX needed)."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from netpath_graph import candidate_paths, choose_path, parse_policy, ports_along, uses_link  # noqa: E402

# The multipath lab: s1 connects to s2, s3 and s5, which all connect to s4.
#   (a, a_port, b, b_port)
LINKS = {(1, 2, 2, 1), (2, 2, 4, 1), (1, 3, 3, 1), (3, 2, 4, 2), (1, 4, 5, 1), (4, 3, 5, 2)}


class Paths(unittest.TestCase):
    def test_three_alternatives_shortest_first(self):
        self.assertEqual(candidate_paths(LINKS, 1, 4), [[1, 2, 4], [1, 3, 4], [1, 5, 4]])

    def test_reverse_direction_uses_the_same_switches(self):
        fwd = choose_path(candidate_paths(LINKS, 1, 4), ("auto", None))
        rev = choose_path(candidate_paths(LINKS, 4, 1), ("auto", None))
        self.assertEqual(fwd, list(reversed(rev)))

    def test_same_switch(self):
        self.assertEqual(candidate_paths(LINKS, 3, 3), [[3]])

    def test_failed_link_leaves_the_alternatives(self):
        without_s2_s4 = LINKS - {(2, 2, 4, 1)}
        paths = candidate_paths(without_s2_s4, 1, 4)
        self.assertNotIn([1, 2, 4], paths)
        self.assertEqual(paths[0], [1, 3, 4])

    def test_no_path(self):
        self.assertEqual(candidate_paths(set(), 1, 4), [])
        self.assertIsNone(choose_path([], ("auto", None)))


class Policy(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(parse_policy("auto"), ("auto", None))
        self.assertEqual(parse_policy("via 5\n"), ("via", 5))
        self.assertEqual(parse_policy("path 1 3 4"), ("path", [1, 3, 4]))
        self.assertEqual(parse_policy("nonsense"), ("auto", None))
        self.assertEqual(parse_policy(""), ("auto", None))

    def test_choose(self):
        c = candidate_paths(LINKS, 1, 4)
        self.assertEqual(choose_path(c, ("via", 5)), [1, 5, 4])
        self.assertEqual(choose_path(c, ("path", [4, 3, 1])), [1, 3, 4])
        self.assertEqual(choose_path(c, ("via", 9)), [1, 2, 4])  # impossible: falls back to shortest


class Ports(unittest.TestCase):
    def test_out_ports_along_path(self):
        self.assertEqual(ports_along(LINKS, [1, 5, 4], last_port=9), [(1, 4), (5, 2), (4, 9)])

    def test_uses_link(self):
        self.assertTrue(uses_link([1, 2, 4], 4, 2))
        self.assertFalse(uses_link([1, 3, 4], 2, 4))


if __name__ == "__main__":
    unittest.main()
