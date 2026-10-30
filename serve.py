"""Local dev server that disables browser caching, so edits show up on a normal refresh.

It also connects the SDN Lab page to the Mininet + POX lab on the same machine:

    GET  /api/sdn/topology   the POX controller's export (/tmp/netpath_topology.json)
    GET  /api/sdn/routed     the routed lab's recorded traceroute (sdn/results or sdn/sample-results)
    *    /api/lab/...        forwarded to the lab control API (sudo python3 sdn/multipath.py --serve)

Usage: python serve.py [port]   (default: $PORT or 5173; listens on localhost only)
"""
import functools
import http.server
import json
import os
import sys
import time
import urllib.error
import urllib.request

TOPOLOGY_FILE = os.environ.get("NETPATH_TOPOLOGY", "/tmp/netpath_topology.json")
LAB_URL = os.environ.get("NETPATH_LAB", "http://127.0.0.1:8765")
ROOT = os.path.dirname(os.path.abspath(__file__))
# what `sudo python3 sdn/topology.py --auto` saved, newest location first
ROUTED_FILES = ["sdn/results/traceroute.txt", "sdn/sample-results/traceroute.txt"]


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def send_json(self, code, data):
        body = data if isinstance(data, bytes) else json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/sdn/topology":
            return self.topology()
        if path == "/api/sdn/routed":
            return self.routed()
        if path.startswith("/api/lab/"):
            return self.forward()
        super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/lab/"):
            return self.forward()
        self.send_json(404, {"error": "not found"})

    def topology(self):
        try:
            with open(TOPOLOGY_FILE, "rb") as f:
                data = json.load(f)
            data["age_s"] = round(time.time() - os.path.getmtime(TOPOLOGY_FILE), 1)
            self.send_json(200, data)
        except FileNotFoundError:
            self.send_json(503, {"error": f"{TOPOLOGY_FILE} not found: is the POX controller running?"})
        except (OSError, ValueError) as e:
            self.send_json(503, {"error": f"could not read {TOPOLOGY_FILE}: {e}"})

    def routed(self):
        for rel in ROUTED_FILES:
            full = os.path.join(ROOT, rel)
            try:
                with open(full, encoding="utf-8", errors="replace") as f:
                    text = f.read()
            except OSError:
                continue
            if text.strip():
                return self.send_json(200, {"file": rel, "mtime": os.path.getmtime(full), "text": text})
        self.send_json(404, {"error": "no recorded traceroute: run sudo python3 sdn/topology.py --auto"})

    def forward(self):
        """Pass the request to the lab control API, which only listens on localhost."""
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        url = LAB_URL + self.path[len("/api/lab"):]
        req = urllib.request.Request(url, data=body, method=self.command,
                                     headers={"Content-Type": "application/json"})
        try:
            # compare and failover runs take up to about a minute
            with urllib.request.urlopen(req, timeout=180) as r:
                self.send_json(r.status, r.read())
        except urllib.error.HTTPError as e:
            self.send_json(e.code, e.read())
        except (urllib.error.URLError, OSError):
            self.send_json(503, {"error": "lab not running: start it with sudo python3 sdn/multipath.py --serve"})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", 5173))
    handler = functools.partial(NoCacheHandler, directory=ROOT)
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"Serving {ROOT} at http://localhost:{port} (caching disabled)")
        print(f"SDN Lab: topology from {TOPOLOGY_FILE}, lab API at {LAB_URL}")
        httpd.serve_forever()
