# NetPath SDN lab: Mininet + POX

A software-defined network for testing our traceroute and path analysis on a network where **we control everything**. Mininet builds the virtual network, POX is the SDN controller that decides how every switch forwards traffic, and our Python tool runs inside it to find the problems we planted on purpose.

```
h1 ─ s1 ─ r1 ─ s2 ─ r2 ─ s3 ─ r3 ─ s4 ─ h2
                         ▲           ▲
          long-haul: +60 ms RTT    last mile: ~15% loss each way
```

| Node | Role |
|------|------|
| `h1` 10.0.1.2 | Client: runs traceroute and path analysis |
| `h2` 10.0.4.2 | Server: the destination |
| `r1`, `r2`, `r3` | Routers (Linux hosts with IP forwarding). Each one is a traceroute hop |
| `s1`–`s4` | OpenFlow switches with no logic of their own. POX decides everything |

**Why routers?** OpenFlow switches work at layer 2 and never decrement the TTL, so a chain of switches is invisible to traceroute: it would show the whole path as one hop. The routers between the switches give traceroute real hops to discover.

## Files

| File | What it is |
|------|-----------|
| `topology.py` | The Mininet network: hosts, routers, switches, the delay and loss, the routes |
| `netpath_controller.py` | The POX component: learning switch, live firewall switch, flow logging |
| `results/` | Created by `--auto`: the traceroute and path-analysis output |

## 1. Set up a Linux VM on the Mac (about 15 minutes, once)

Mininet needs Linux. Multipass gives you an Ubuntu VM with a few commands and works on both Apple Silicon (M1–M4) and Intel Macs. The official Mininet VM image is Intel-only, so skip it on Apple Silicon.

```bash
brew install --cask multipass
multipass launch 22.04 --name sdn --cpus 2 --memory 4G --disk 15G
multipass shell sdn
```

Inside the VM:

```bash
sudo apt update
sudo apt install -y mininet openvswitch-switch traceroute git python3-pip
git clone https://github.com/noxrepo/pox
git clone https://github.com/AtharvChoudhary65/network-diagnostics-and-path-analysis-tool
pip3 install dnspython
```

Copy this `sdn/` folder into the VM. From a Mac terminal, in this repository:

```bash
multipass transfer --recursive sdn sdn:/home/ubuntu/
```

Then install the controller component into POX:

```bash
cp ~/sdn/netpath_controller.py ~/pox/ext/
```

## 2. Run it

You need **two terminals** in the VM. Open the second one with `multipass shell sdn` from another Mac terminal.

**Terminal 1, the controller (start it first):**

```bash
cd ~/pox && ./pox.py log.level --INFO netpath_controller
```

Wait for `switch s1 connected` … `s4 connected` once the network starts.

**Terminal 2, the network:**

```bash
cd ~/sdn && sudo python3 topology.py --auto
```

`--auto` runs a plain traceroute and then our path analysis from `h1` to `h2`, prints both, saves them to `results/`, and opens the Mininet CLI. Leave out `--auto` to go straight to the CLI. Useful CLI commands:

```
h1 traceroute -n h2
h1 ping -c 4 h2
h1 cd ~/network-diagnostics-and-path-analysis-tool && python3 -m path_analysis 10.0.4.2
pingall
exit
```

## 3. The demo (about 3 minutes)

**a. Normal path: the tool finds both planted problems.**

Run `--auto` or the commands above. What you should see (exact numbers vary from run to run):

- traceroute shows four hops: `10.0.1.1` (r1), `10.0.2.2` (r2), `10.0.3.2` (r3), `10.0.4.2` (h2).
- Hop 3 is about **60 ms slower** than hop 2: the long-haul link. Path analysis flags it, because the jump is over `jump_ms = 50`.
- Hop 4 (`h2`) usually loses some probes. With 15% loss each way, roughly 1 probe in 4 goes missing. When it is 20% or more, path analysis flags it as partial loss. Three probes is a small sample, so run it twice, or use `traceroute -n -q 10 h2` to show the loss more clearly.

**b. SDN firewall: block the destination with a flow rule.**

In a third VM shell, or in the Mininet CLI with `sh`:

```bash
touch /tmp/netpath_firewall
```

Terminal 1 logs `firewall turned ON`. Every switch's flow table is cleared, and from now on `s4` installs **drop rules** for traffic to `h2`. Run `h1 traceroute -n h2` again: r1, r2 and r3 still answer, then `* * *` until 30 hops, and path analysis reports **destination reached: no**. This is the website's "destination behind firewall" scenario, but real, and done by the SDN controller.

**c. Turn it off.**

```bash
rm /tmp/netpath_firewall
```

The flows are cleared again and the destination answers on the next run.

**Show the website too:** open `traceroute.html`, paste `results/traceroute.txt` into the **Parser playground**, and the same hops are parsed and colour-coded. Then use **Analyze this path**.

## How this covers the SDN topics

| SDN idea | Where it happens here |
|----------|----------------------|
| Separate control plane and data plane | Switches only forward. POX (`netpath_controller.py`) makes every decision |
| OpenFlow | Switches run OpenFlow 1.0. POX receives **packet-in** events and replies with **flow-mod** rules and **packet-out** messages |
| Flow tables | Learned flows expire after 10 s idle or 30 s total. The firewall change deletes them all (`OFPFC_DELETE`) |
| Policy by software | The firewall is a flow rule with no actions (drop), switched on and off without touching the network |
| Network emulation | Mininet's `TCLink` adds the delay and loss, so the problems are known in advance and the tool can be checked against them |

## Tuning

```bash
sudo python3 topology.py --delay 80 --loss 25   # bigger jump, more loss
sudo python3 topology.py --tool /path/to/tool   # if the tool repo is somewhere else
```

POX options: `./pox.py netpath_controller --firewall_switch=4 --protected=10.0.4.2 --flag=/tmp/netpath_firewall`

## Troubleshooting

- **`Unable to contact the remote controller`**: start POX first (terminal 1), then the topology.
- **Leftovers after a crash**: `sudo mn -c`
- **POX fails with Python errors**: some POX branches need an older Python. In `~/pox` run `git branch -a` and `git checkout` the newest branch listed, then try again.
- **traceroute shows only one hop**: the routes did not install. In the CLI, `r1 ip route` should list `10.0.3.0/24` and `10.0.4.0/24`.
- **Everything times out**: check that terminal 1 shows all four switches connected. Without the controller the switches forward nothing (fail-secure mode), which shows how the data plane depends on the control plane.
