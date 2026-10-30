"""Tests for correlate.py with results shaped like netprobe + netpath_controller output."""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import correlate  # noqa: E402
import netprobe  # noqa: E402

SRC, DST = "10.0.0.1", "10.0.0.2"
LINKS = [{"a": a, "a_port": 1, "b": b, "b_port": 1} for a, b in
         [("s1", "s2"), ("s2", "s4"), ("s1", "s3"), ("s3", "s4"), ("s1", "s5"), ("s4", "s5")]]
ALTS = [["s1", "s2", "s4"], ["s1", "s3", "s4"], ["s1", "s5", "s4"]]


def topology(path, failed_links=(), failed_paths=(), links=LINKS):
    return {"switches": ["s1", "s2", "s3", "s4", "s5"], "links": list(links),
            "hosts": [{"mac": "00:00:00:00:00:01", "ip": SRC, "switch": "s1", "port": 1},
                      {"mac": "00:00:00:00:00:02", "ip": DST, "switch": "s4", "port": 1}],
            "paths": {f"{SRC}->{DST}": {"switches": path, "policy": "x", "since": 0}},
            "alternatives": {f"{SRC}->{DST}": ALTS},
            "failed_links": list(failed_links), "failed_paths": list(failed_paths)}


def probe(rtts, sent, lost_seq=()):
    stats = netprobe.summarize(sent, rtts)
    stats["lost_seq"] = list(lost_seq)
    return {"mode": "probe", "interval": 0.05, "stats": stats}


class Correlate(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        runs = []

        def add(name, policy, path, rtts, sent, lost=(), event=None, **topo):
            self.write(f"probe_{name}.json", probe(rtts, sent, lost))
            self.write(f"topology_{name}.json", topology(path, **topo))
            r = {"name": name, "policy": policy, "probe": f"probe_{name}.json", "topology": f"topology_{name}.json"}
            if event:
                r["event"] = event
            runs.append(r)

        add("auto", "auto", ["s1", "s2", "s4"], [12.0] * 60, 60)
        add("path-B-via-s3", "via 3", ["s1", "s3", "s4"], [84.0] * 60, 60)
        add("path-C-via-s5", "via 5", ["s1", "s5", "s4"], [12.5] * 48, 60, lost=range(48, 60))
        add("failover", "auto", ["s1", "s3", "s4"], [12.0] * 80 + [84.0] * 200, 300, lost=range(80, 100),
            event="link s2-s4 taken down",
            failed_links=[{"link": "s2-s4", "at": 1, "reason": "port s4.2 down"}],
            failed_paths=[{"conversation": f"{SRC}->{DST}", "path": ["s1", "s2", "s4"], "link": "s2-s4", "at": 1}])
        self.write("runs.json", {"src": SRC, "dst": DST, "runs": runs})

    def write(self, name, data):
        with open(os.path.join(self.dir, name), "w") as f:
            json.dump(data, f)

    def test_ranking_and_best_path(self):
        a = correlate.analyse(self.dir)
        self.assertEqual(a["best"], "auto")
        self.assertEqual(a["ranking"], ["auto", "path-B-via-s3", "path-C-via-s5"])  # 20% loss costs 200 ms

    def test_links_explain_the_difference(self):
        runs = {r["name"]: r for r in correlate.analyse(self.dir)["runs"]}
        slow = runs["path-B-via-s3"]["explained_by"]
        self.assertEqual(slow["links"], ["s1-s3", "s3-s4"])
        self.assertEqual(slow["extra_ms"], 72.0)
        lossy = runs["path-C-via-s5"]["explained_by"]
        self.assertEqual(lossy["links"], ["s1-s5", "s4-s5"])
        self.assertEqual(lossy["extra_loss_pct"], 20.0)
        self.assertEqual(runs["path-B-via-s3"]["status"], "SLOW")
        self.assertEqual(runs["path-C-via-s5"]["status"], "LOSSY")

    def test_failed_path_and_outage(self):
        f = correlate.analyse(self.dir)["failure"]
        self.assertEqual(f["path_before"], ["s1", "s2", "s4"])
        self.assertEqual(f["path_after"], ["s1", "s3", "s4"])
        self.assertEqual(f["failed_paths"][0]["path"], ["s1", "s2", "s4"])
        self.assertEqual(f["outages"], [(80, 99, 1.0)])

    def test_report_text_and_files(self):
        self.assertEqual(correlate.main([self.dir]), 0)
        text = open(os.path.join(self.dir, "report.txt")).read()
        for expected in ("alternative paths 10.0.0.1 -> 10.0.0.2: 3", "from links s1-s3, s3-s4",
                         "failed path for 10.0.0.1->10.0.0.2: s1 -> s2 -> s4", "interrupted for about 1.0 s",
                         "best path: 10.0.0.1 -> s1 -> s2 -> s4 -> 10.0.0.2"):
            self.assertIn(expected, text)
        self.assertTrue(os.path.exists(os.path.join(self.dir, "report.json")))


if __name__ == "__main__":
    unittest.main()
