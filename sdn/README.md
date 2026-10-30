# NetPath SDN lab: Mininet + POX + UDP probes

A socket-based network diagnostic application that measures delay, packet loss and path characteristics with its own UDP probes, and correlates the results with the topology of a software-defined network.

- **Mininet** builds the network.
- **POX** is the SDN controller: it discovers the topology and decides which path traffic takes.
- **netprobe** measures the network over UDP sockets.
- **correlate** joins the measurements with the controller's view of the network.

## Deliverables

| Deliverable | Where | How |
|---|---|---|
| Socket-based application, UDP | `netprobe.py` | Built on the socket API: `SOCK_DGRAM` for probes, `SOCK_RAW` for ICMP replies. No ping or traceroute programs involved |
| Implement UDP diagnostic probes | `netprobe.py probe` / `server` | Numbered, timestamped UDP datagrams echoed by a UDP server |
| Measure round-trip time | `netprobe.py probe` | Per-probe RTT, plus min/avg/max/stdev and RFC 3550-style jitter |
| Detect packet loss | `netprobe.py probe` | Loss %, exactly which probes were lost, reordering, duplicates |
| Implement path analysis | `netprobe.py trace` + the project's `path_analysis` | UDP traceroute on sockets (TTL 1, 2, 3 …, ICMP time exceeded / port unreachable). Hops go to `analyze_path()` for jitter, loss and latency jumps |
| Discover SDN topology | `netpath_controller.py` | Switches from OpenFlow connections, links over LLDP (`openflow.discovery`), hosts from where their traffic enters. Exported to `/tmp/netpath_topology.json` |
| Correlate measurements with network paths | `correlate.py` | Joins each probe run with the switch path the controller used, and attributes extra delay or loss to the links that differ from the best path |
| Identify failed paths | controller + `correlate.py` | Port-down and LLDP-timeout detection, a record of which active paths used the failed link, automatic rerouting, and the measured outage length |
| Compare alternative paths | `multipath.py` + `correlate.py` | Three paths (fast, slow, lossy), each forced in turn with a live route policy, measured and ranked |

## The two labs

**Multipath lab, `multipath.py`:** path comparison, failure and correlation.

```
                ┌─ s2 ─┐   path A: fast (2 ms links)
    h1 ── s1 ───┼─ s3 ─┼─── s4 ── h2      path B: slow (20 ms links)
                └─ s5 ─┘   path C: fast, but s5–s4 drops 10% of packets
```

`h1` is 10.0.0.1, `h2` is 10.0.0.2. All five switches are OpenFlow switches run by POX.

**Routed lab, `topology.py`:** hop-by-hop path analysis.

```
h1 ─ s1 ─ r1 ─ s2 ─ r2 ─ s3 ─ r3 ─ s4 ─ h2       +60 ms RTT on s3–r3, loss on s4–h2
```

OpenFlow switches work at layer 2 and never decrement the TTL, so a traceroute through switches alone shows a single hop. The Linux routers r1–r3 give traceroute real hops, which is what per-hop path analysis needs.

## Files

| File | What it is |
|------|-----------|
| `netprobe.py` | The socket-based UDP application: `server`, `probe`, `trace` |
| `netpath_controller.py` | POX component: topology discovery, path routing, route policy, failover, firewall, topology export |
| `netpath_graph.py` | Path logic used by the controller (copy it into `pox/ext/` too) |
| `multipath.py` | Multipath Mininet lab; `--auto` runs the whole experiment |
| `topology.py` | Routed Mininet lab for traceroute and path analysis |
| `correlate.py` | Joins measurements with the controller's topology and writes the report |
| `tests/` | 20 tests that run anywhere: `python3 -m unittest discover -s tests` |

## 1. Setup

You need **Linux**: Mininet uses Linux network namespaces, Open vSwitch and `tc`. On a Linux machine (Ubuntu or Debian):

```bash
sudo apt update && sudo apt install -y mininet openvswitch-switch traceroute git
cd ~ && git clone https://github.com/noxrepo/pox
git clone https://github.com/AtharvChoudhary65/network-diagnostics-and-path-analysis-tool
cp <this repo>/sdn/netpath_controller.py <this repo>/sdn/netpath_graph.py ~/pox/ext/
```

POX's default branch runs on Python 3. Nothing else needs installing: the lab only uses Python's standard library.

**On a Mac**, run the same steps inside an Ubuntu VM. Multipass works on Apple Silicon and Intel:

```bash
brew install --cask multipass
multipass launch 22.04 --name sdn --cpus 2 --memory 4G --disk 15G
multipass transfer --recursive sdn sdn:/home/ubuntu/
multipass shell sdn
```

## 2. Start the controller (terminal 1, always first)

```bash
cd ~/pox && ./pox.py log.level --INFO openflow.discovery openflow.spanning_tree --no-flood --hold-down netpath_controller
```

- `openflow.discovery` finds the links (LLDP).
- `openflow.spanning_tree` keeps ARP broadcasts from looping around the multipath triangle.

You'll see `switch s1 connected` …, `link up s1-s2` …, and `path 10.0.0.1->10.0.0.2: s1 -> s2 -> s4`.

## 3. Run the multipath experiment (terminal 2)

```bash
cd <this repo>/sdn && sudo python3 multipath.py --auto
```

It takes about 1.5 minutes:

1. Waits for the controller to discover the topology, then pings once so the controller learns where the hosts are.
2. Starts the UDP echo server on h2.
3. Measures with 60 UDP probes each:
   - the **auto** route
   - **path A** (`via 2`)
   - **path B** (`via 3`)
   - **path C** (`via 5`)

   The route is switched live by writing to `/tmp/netpath_route`.
4. **Failure test:** probes for 15 s on the auto path and takes link s2–s4 down after 4 s. The controller detects the failure, records the failed path and reroutes.
5. Runs `correlate.py` and prints the report, also saved to `results/report.txt` and `results/report.json`.

The report has five sections: the discovered topology and the alternative paths, measurements per path, which links explain the differences, failed paths and the outage length, and the recommended path.

The routes can also be changed by hand while the CLI is open:

```bash
echo "via 3" > /tmp/netpath_route    # force path B; also: auto, via 2, via 5, path 1 5 4
h2 python3 netprobe.py server &      # in the Mininet CLI
h1 python3 netprobe.py probe 10.0.0.2
link s2 s4 down                      # Mininet CLI: fail a link
```

## 4. Run the routed lab (traceroute and path analysis)

```bash
cd <this repo>/sdn && sudo python3 topology.py --auto
```

From h1 to h2 it runs, in order:
1. our **socket-based UDP traceroute** (`netprobe.py trace`), with the hops handed to the project's `path_analysis`
2. a UDP probe run
3. the system `traceroute`
4. the project's `python3 -m path_analysis`, for comparison

The outputs are saved in `results/`. Expect hops r1, r2, r3 and h2, a jump of about 60 ms at hop 3, and partial loss at h2.

**SDN firewall:** run `touch /tmp/netpath_firewall`, and switch s4 drops traffic to the protected hosts. Traceroute then stops after r3. Remove the file to undo it.

## Talking points

- **Control and data plane split:** the switches only forward. POX makes every decision and installs OpenFlow rules (packet-in → flow-mod).
- **The app sees what the network does:** the same UDP probe measures about 12 ms on path A, about 84 ms on path B and about 10% loss on path C. Correlation attributes the difference to exactly the links that path does not share.
- **Failure handling:** a link goes down, the controller detects it, marks the paths that used it as failed and reroutes. The app measures how long traffic was interrupted.
- **Why routers in the routed lab:** switches don't decrement TTL, so they are invisible to traceroute.

## Troubleshooting

- **`Unable to contact the remote controller`:** start POX first.
- **Leftovers after a crash:** `sudo mn -c`
- **No `link up` lines in the POX log:** `openflow.discovery` is missing from the POX command line.
- **pingall hangs in the multipath lab:** `openflow.spanning_tree --no-flood --hold-down` is missing, so broadcasts loop.
- **`correlate.py` says "no path reported":** the controller had not seen traffic yet when the snapshot was taken. Rerun, or increase the wait in `multipath.py`.
- **`trace` says it needs a raw socket:** run it as root. Mininet already does.


## Execution timeline (a full run, start to finish)

Tested on Ubuntu with Mininet, Open vSwitch and POX 0.7.0. Everything runs inside Linux, in two terminals.

### 0. One-time setup

```bash
sudo apt update && sudo apt install -y mininet openvswitch-switch traceroute git
cd ~
git clone https://github.com/AgentDragonBlox/Networks-Project-Website
git clone https://github.com/noxrepo/pox
git clone https://github.com/AtharvChoudhary65/network-diagnostics-and-path-analysis-tool
cp ~/Networks-Project-Website/sdn/netpath_controller.py ~/Networks-Project-Website/sdn/netpath_graph.py ~/pox/ext/
```

### 1. Multipath lab

**Terminal 1** (leave running):

```bash
cd ~/pox && ./pox.py log.level --INFO openflow.discovery openflow.spanning_tree --no-flood --hold-down netpath_controller
```

Expected: `NetPath controller ready, policy 'auto'` and `POX 0.7.0 (gar) is up.`

**Terminal 2** (after POX is up):

```bash
cd ~/Networks-Project-Website/sdn && sudo python3 multipath.py --auto
```

About 1.5 minutes. It measures auto and paths A, B and C, takes link s2-s4 down, then prints the correlation report (saved as `results/report.txt`). Type `exit` at the `mininet>` prompt when it finishes.

### 2. Routed lab (traceroute and path analysis)

Terminal 2:

```bash
sudo mn -c
```

Terminal 1: press Ctrl+C, then restart POX **without spanning tree**:

```bash
cd ~/pox && ./pox.py log.level --INFO openflow.discovery netpath_controller
```

Terminal 2:

```bash
cd ~/Networks-Project-Website/sdn && sudo python3 topology.py --auto
```

The routed lab has no switch-to-switch links, so with `openflow.spanning_tree --hold-down` flooding never turns on and every probe is lost (30 silent hops, 100% loss). Use plain `openflow.discovery` for this lab. When done: `exit`, then `sudo mn -c`, then Ctrl+C in terminal 1.

### 3. Results

Outputs are written to `sdn/results/` (git-ignored). Copies are in [`sample-results/`](sample-results/):

| File | From |
|---|---|
| `report.txt`, `report.json` | multipath lab: topology, per-path measurements, correlation, failed paths, best path |
| `netprobe_trace.txt` | routed lab: our UDP traceroute plus path analysis |
| `netprobe_probe.txt` | routed lab: 100 UDP probes (RTT, jitter, loss) |
| `traceroute.txt` | routed lab: system traceroute |
| `path_analysis.txt` | routed lab: the original project's `path_analysis` |

Observed: path A is best (about 13 ms, 0% loss), path B about 85 ms, path C about 16.7% loss. When link s2-s4 fails, traffic moves to s1-s3-s4. In the routed lab there is a +65 ms jump at hop 3 and about 28% loss on the probe run.

### Notes

- POX warns that Python 3.12 is unsupported and prints `ERROR:packet:(dns) parsing ...` lines. These are harmless.
- `Unable to contact the remote controller`: start POX first.