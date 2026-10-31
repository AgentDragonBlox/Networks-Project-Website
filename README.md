# NetPath Lab

An interactive demo site for the [Network Diagnostics and Path Analysis Tool](https://github.com/AtharvChoudhary65/network-diagnostics-and-path-analysis-tool). Each Python module gets its own page with a live lab that walks through how the code works, from input validation and regex parsing to the statistics and the exact terminal output.

It is a static site (HTML, CSS and vanilla JavaScript) with no build step and no dependencies.

## Pages

| Page | Module | What you can do |
|------|--------|-----------------|
| `index.html` | — | Overview, plus a one-click pipeline that runs all four modules on a target |
| `dns.html` | `dns/dns_lookup.py` | Resolve names live over DNS-over-HTTPS and watch each branch of `resolve()` |
| `ping.html` | `ping_rtt/ping.py` | Send simulated pings and see the RTT regex, loss maths and `display_results()` box |
| `traceroute.html` | `traceroute/traceroute.py` | TTL explainer, hop-by-hop trace, and a playground that parses real `tracert`/`traceroute` output |
| `analysis.html` | `path_analysis/analyzer.py` | Edit hop data, tune `jump_ms` / `loss_thresh` and see bottlenecks flagged |
| `sdn.html` | `sdn/` (Mininet + POX) | Live SDN topology from the POX controller, route policies, link failures, the firewall, UDP probes and path correlation |

Pages hand results to each other through the URL, so these links can be shared:

- `dns.html?target=example.com&run=1`
- `ping.html?target=1.1.1.1&run=1`
- `traceroute.html?target=8.8.8.8&scenario=ocean&run=1`
- `analysis.html?path=<json>`, where the JSON is `{"target", "reached", "hops": [{"hop", "ip", "rtts"}]}`

## What's real and what's simulated

- **DNS** lookups are real in *Live* mode. They are sent to Cloudflare's public resolver (`cloudflare-dns.com`) over DNS-over-HTTPS. If it can't be reached, the page falls back to built-in sample data.
- **Ping and traceroute** can't run in a browser, because browsers can't send ICMP packets. These pages use a simulated network that prints the same text as `ping`, `tracert` and `traceroute`.
- **SDN Lab** is live when the Mininet + POX lab runs on the same Linux machine (see below). Otherwise it uses a clearly labelled model of the same network.
- **Everything after the raw output** is a direct JavaScript port of the Python code: validation, regexes, parsing, statistics, bottleneck rules and printed reports. The output was checked against the original Python on the same inputs.

## Run locally

Opening `index.html` directly in a browser works. To serve it instead:

```bash
python serve.py
```

Then open <http://localhost:5173>. `serve.py` is a small static server that turns off browser caching, so your edits show up on a normal refresh. It also connects the SDN Lab page to the lab: it serves the POX controller's export (`/tmp/netpath_topology.json`) at `/api/sdn/topology` and forwards `/api/lab/*` to `sudo python3 sdn/multipath.py --serve`. `/api/sdn/routed` serves the routed lab's recorded `traceroute.txt` from `sdn/results/` (or `sdn/sample-results/`, which git keeps), so the page shows a real run instead of the simulated hop chain. Everything listens on localhost only.

## Deploy to GitHub Pages

All paths are relative, so the site can be served from any folder:

1. Push the repository to GitHub.
2. Go to **Settings → Pages**, choose **Deploy from a branch**, and select your branch and the `/ (root)` folder.
3. The site will be published at `https://<user>.github.io/<repo>/`.

## Project structure

```
index.html  dns.html  ping.html  traceroute.html  analysis.html  sdn.html
css/styles.css     design system: light/dark themes, glass surfaces, layout
js/common.js       shared helpers: seeded RNG, Python-style formatting, IP parsing, tabs, theme colours
js/dns.js          port of dns/dns_lookup.py
js/ping.js         port of ping_rtt/ping.py + simulated ICMP
js/traceroute.js   port of traceroute/traceroute.py + simulated paths and TTL explainer
js/analysis.js     port of path_analysis/analyzer.py + charts
js/sdn.js          SDN Lab page: live topology, lab controls, port of sdn/correlate.py, example-mode model
js/app.js          per-page start-up, theme toggle, overview pipeline
serve.py           no-cache local dev server + SDN lab API proxy
sdn/               Mininet + POX lab and the UDP diagnostic app
```

When you change a CSS or JS file, bump the `?v=` number on its `<link>`/`<script>` tags in the HTML pages. This makes browsers that cached the old file download the new one.

## SDN lab (Mininet + POX)

[`sdn/`](sdn/README.md) is the socket-based UDP diagnostic application and its SDN testbed:

- `netprobe.py` measures RTT, jitter, packet loss and hop-by-hop paths with its own UDP probes.
- A POX controller discovers the topology over LLDP, routes traffic on chosen paths and reroutes around failed links.
- Two Mininet labs: a multipath network that compares fast, slow and lossy paths and tests a link failure, and a routed network for traceroute.
- `correlate.py` joins the measurements with the controller's topology.
- `sdn.html` shows all of it live: start POX, `sudo python3 sdn/multipath.py --serve` and `python3 serve.py`, then open <http://localhost:5173/sdn.html>.

It needs Linux. The README maps every course deliverable to the code and covers running it in a VM on a Mac.

## Credits

The diagnostics tool and its Python code come from [AtharvChoudhary65/network-diagnostics-and-path-analysis-tool](https://github.com/AtharvChoudhary65/network-diagnostics-and-path-analysis-tool). This site is an interactive companion to it. Fonts are [Geist and Geist Mono](https://vercel.com/font), loaded from Google Fonts.
Team: AgentDragonBlox, Atharv Choudhary, Andrew (DNS resolution and UDP probing).