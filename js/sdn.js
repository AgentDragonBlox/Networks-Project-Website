/* SDN Lab page: the Mininet + POX multipath lab from sdn/.
 *
 * Live mode: serve.py hands the page the POX controller's topology export
 * (/api/sdn/topology) and forwards the controls to the lab control API that
 * `sudo python3 sdn/multipath.py --serve` runs (/api/lab/*).
 * Example mode: when the lab isn't running, a small model of the same network
 * answers in the same JSON shapes, so every control still works (clearly labelled).
 */
(function () {
  const { $, esc } = NP;
  const SRC = "10.0.0.1", DST = "10.0.0.2", CONV = SRC + "->" + DST;
  const POLICY_RE = /^(auto|via \d+|path( \d+)+)$/;
  const LOSS_WEIGHT_MS = 10; // correlate.py: each 1% of loss counts like 10 ms of delay
  const POLICIES = [["auto", "auto"], ["path-A-via-s2", "via 2"], ["path-B-via-s3", "via 3"], ["path-C-via-s5", "via 5"]];

  // Drawing positions in the 760 x 330 topology view
  const POS = { pox: [380, 40], h1: [70, 210], s1: [215, 210], s2: [380, 125], s3: [380, 210], s5: [380, 295], s4: [545, 210], h2: [690, 210] };
  // switch links of multipath.py: [a, b, one-way delay ms, loss %, path]
  const LINKS = [["s1", "s2", 2, 0, "A"], ["s2", "s4", 2, 0, "A"], ["s1", "s3", 20, 0, "B"], ["s3", "s4", 20, 0, "B"], ["s1", "s5", 2, 0, "C"], ["s5", "s4", 2, 10, "C"]];
  const SWITCHES = ["s1", "s2", "s3", "s4", "s5"];
  const PCOL = { A: "var(--pa)", B: "var(--pb)", C: "var(--pc)" };
  const pathName = (p) => (p ? { s2: "A", s3: "B", s5: "C" }[p[1]] || null : null);
  const badge = (n) => (n ? `<span class="pbadge p${n}">${n}</span>` : "");
  const key = (a, b) => [a, b].sort().join("-");
  const linksOf = (p) => new Set(p ? p.slice(1).map((s, i) => key(p[i], s)) : []);
  const pathStr = (p) => (p ? [SRC, ...p, DST].join(" → ") : "(no path reported)");
  const f2 = (v, unit = "") => (v == null ? "-" : v.toFixed(2) + unit);
  const clock = (t) => new Date(t * 1000).toLocaleTimeString([], { hour12: false });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const pyFloat = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v)); // how Python prints a float
  function gauss() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

  // ------------------------------------------------------------------ netprobe.summarize()
  function summarize(sent, rtts) {
    const received = rtts.length;
    const s = { sent, received, loss_pct: sent ? +((100 * (sent - received)) / sent).toFixed(2) : 100, duplicates: 0, reordered: 0,
      min_ms: null, avg_ms: null, max_ms: null, stdev_ms: null, jitter_ms: null };
    if (received) {
      const avg = rtts.reduce((a, b) => a + b, 0) / received;
      s.min_ms = +Math.min(...rtts).toFixed(3);
      s.avg_ms = +avg.toFixed(3);
      s.max_ms = +Math.max(...rtts).toFixed(3);
      s.stdev_ms = +Math.sqrt(rtts.reduce((a, r) => a + (r - avg) ** 2, 0) / received).toFixed(3);
      const diffs = rtts.slice(1).map((r, i) => Math.abs(r - rtts[i]));
      s.jitter_ms = diffs.length ? +(diffs.reduce((a, b) => a + b, 0) / diffs.length).toFixed(3) : 0;
    }
    return s;
  }

  function probeText(p) {
    const s = p.stats;
    return `netprobe ${p.target}:${p.port}  ${s.sent} sent, ${s.received} received, ${s.loss_pct}% loss, ${s.reordered} reordered, ${s.duplicates} duplicates\n` +
      `rtt min/avg/max/stdev = ${f2(s.min_ms)}/${f2(s.avg_ms)}/${f2(s.max_ms)}/${f2(s.stdev_ms)} ms   jitter = ${f2(s.jitter_ms)} ms`;
  }

  // ------------------------------------------------------------------ port of correlate.py
  function convPath(topo, src, dst) {
    const paths = (topo && topo.paths) || {};
    if (paths[`${src}->${dst}`]) return paths[`${src}->${dst}`].switches;
    if (paths[`${dst}->${src}`]) return [...paths[`${dst}->${src}`].switches].reverse();
    return null;
  }
  const score = (s) => (s.received ? s.avg_ms + LOSS_WEIGHT_MS * s.loss_pct : Infinity);
  function status(s, bestAvg) {
    if (!s.received) return "FAILED";
    if (s.loss_pct >= 5) return "LOSSY";
    if (bestAvg && s.avg_ms > 2 * bestAvg + 5) return "SLOW";
    return "OK";
  }
  function outages(lost, interval) {
    const spans = [];
    for (const q of lost) {
      if (spans.length && q === spans[spans.length - 1][1] + 1) spans[spans.length - 1][1] = q;
      else spans.push([q, q]);
    }
    return spans.map(([a, b]) => [a, b, +((b - a + 1) * interval).toFixed(2)]);
  }
  function analyse(runsIn) {
    const runs = runsIn.map((r) => ({ ...r, stats: r.probe.stats, interval: r.probe.interval || 0.05, path: convPath(r.topology, SRC, DST) }));
    const ranked = runs.filter((r) => !r.event).sort((a, b) => score(a.stats) - score(b.stats));
    const best = ranked[0] || null;
    const bestAvg = best ? best.stats.avg_ms : null;
    for (const r of runs) {
      r.status = status(r.stats, bestAvg);
      r.explained_by = null;
      if (best && r !== best && r.path && best.path) {
        const bl = linksOf(best.path);
        const extra = [...linksOf(r.path)].filter((l) => !bl.has(l)).sort();
        const delta = r.stats.received ? r.stats.avg_ms - bestAvg : null;
        r.explained_by = { links: extra, extra_ms: delta == null ? null : +delta.toFixed(2), extra_loss_pct: +(r.stats.loss_pct - best.stats.loss_pct).toFixed(2) };
      }
    }
    const fo = runs.find((r) => r.event);
    let failure = null;
    if (fo) {
      const before = (runs.find((r) => r.name === "auto") || {}).path || null;
      failure = { event: fo.event, failed_links: fo.topology.failed_links || [], failed_paths: fo.topology.failed_paths || [],
        path_before: before, path_after: fo.path, outages: outages(fo.stats.lost_seq || [], fo.interval), loss_pct: fo.stats.loss_pct };
    }
    const topo = (runs.find((r) => r.topology) || {}).topology || {};
    return { src: SRC, dst: DST, runs: runs.map(({ topology, probe, ...r }) => r), ranking: ranked.map((r) => r.name),
      best: best ? best.name : null, failure, alternatives: topo.alternatives || {}, topology: topo };
  }
  function render(a) {
    const t = a.topology || {}, out = ["NETPATH SDN CORRELATION REPORT", "=".repeat(30), ""];
    const p = (path) => (path ? [SRC, ...path, DST].join(" -> ") : "(no path reported)");
    out.push("1. Discovered SDN topology (from the POX controller)");
    out.push(`   switches: ${(t.switches || []).join(", ") || "-"}`);
    out.push(`   links:    ${(t.links || []).map((l) => `${l.a}-${l.b}`).join(", ") || "-"}`);
    for (const h of t.hosts || []) if (h.ip) out.push(`   host ${h.ip.padEnd(10)} on ${h.switch} port ${h.port}`);
    const alts = a.alternatives[CONV] || [];
    out.push(`   alternative paths ${SRC} -> ${DST}: ${alts.length}`);
    for (const x of alts) out.push(`     ${x.join(" -> ")}`);
    out.push("", "2. Measurements per path (netprobe, UDP)");
    out.push(`   ${"run".padEnd(15)}${"path".padEnd(38)}${"avg ms".padStart(8)}${"jitter".padStart(8)}${"loss %".padStart(8)}  status`);
    for (const r of a.runs) {
      const s = r.stats;
      out.push(`   ${r.name.padEnd(15)}${p(r.path).padEnd(38)}${f2(s.avg_ms).padStart(8)}${f2(s.jitter_ms).padStart(8)}${s.loss_pct.toFixed(1).padStart(8)}  ${r.status}`);
    }
    out.push("", "3. Correlation: which links explain the differences");
    const best = a.runs.find((r) => r.name === a.best);
    if (best) out.push(`   baseline: ${a.best} via ${p(best.path)}`);
    for (const r of a.runs) {
      const e = r.explained_by;
      if (!e || r.event || !e.links.length) continue;
      const parts = [];
      if (e.extra_ms != null && Math.abs(e.extra_ms) >= 1) parts.push(`${e.extra_ms >= 0 ? "+" : ""}${e.extra_ms.toFixed(1)} ms`);
      if (e.extra_loss_pct >= 1) parts.push(`+${e.extra_loss_pct.toFixed(1)}% loss`);
      if (parts.length) out.push(`   ${r.name}: ${parts.join(" and ")} vs baseline, from links ${e.links.join(", ")}`);
    }
    out.push("", "4. Failed paths");
    const f = a.failure;
    if (!f) out.push("   none tested");
    else {
      out.push(`   event: ${f.event}`);
      for (const l of f.failed_links) out.push(`   controller saw link ${l.link} fail (${l.reason})`);
      for (const x of f.failed_paths) out.push(`   failed path for ${x.conversation}: ${x.path.join(" -> ")} (used ${x.link})`);
      out.push(`   path before: ${p(f.path_before)}`, `   path after:  ${p(f.path_after)}`);
      if (f.outages.length) {
        const l = f.outages.reduce((m, o) => (o[2] > m[2] ? o : m));
        out.push(`   traffic interrupted for about ${pyFloat(l[2])} s (probes ${l[0]}-${l[1]} lost), ${f.loss_pct}% loss over the run`);
      } else out.push("   no probes lost: rerouting was hitless");
    }
    out.push("", "5. Recommendation");
    if (best) {
      out.push(`   best path: ${p(best.path)} (${f2(best.stats.avg_ms, " ms")}, ${best.stats.loss_pct}% loss)`);
      out.push(`   ranking (delay + ${LOSS_WEIGHT_MS} ms per 1% loss): ${a.ranking.join(", ")}`);
    }
    return out.join("\n");
  }

  // ------------------------------------------------------------------ example mode: a model of the lab
  function makeSim() {
    const now = () => Date.now() / 1000;
    const st = { policy: "auto", firewall: false, up: {}, counters: { packet_in: 0, flow_mod: 0, flood: 0, drop: 0, reroute: 0 },
      events: [], failed_links: [], failed_paths: [], path: null, since: now(), started: now(), busy: null };
    LINKS.forEach(([a, b]) => (st.up[key(a, b)] = true));
    const event = (kind, text) => { st.events.push({ t: now(), kind, text }); if (st.events.length > 60) st.events.shift(); };
    const candidates = () => [["s1", "s2", "s4"], ["s1", "s3", "s4"], ["s1", "s5", "s4"]].filter((p) => [...linksOf(p)].every((l) => st.up[l]));
    function choose() {
      const c = candidates();
      if (!c.length) return null;
      const [kind, ...args] = st.policy.split(" ");
      if (kind === "via") return c.find((p) => p.includes("s" + args[0])) || c[0];
      if (kind === "path") {
        const want = args.map((n) => "s" + n).join();
        return c.find((p) => p.join() === want || [...p].reverse().join() === want) || c[0];
      }
      return c[0];
    }
    function reroute(why) {
      st.path = null;
      st.counters.reroute++;
      event("reroute", `flow tables cleared (${why})`);
    }
    function traffic() { // the first packet of a conversation reaches POX, which installs the path
      if (st.path) return st.path;
      st.counters.packet_in += 2; st.counters.flood += 1;
      const p = choose();
      if (!p) { event("warn", `no path s1 -> s4 for 00:00:00:00:00:02`); return null; }
      st.path = p; st.since = now();
      st.counters.flow_mod += 2 * p.length;
      event("path", `path ${CONV}: ${p.join(" -> ")} (policy ${st.policy})`);
      return p;
    }
    // boot: what the POX log shows when Mininet connects
    st.started -= 40;
    event("start", "controller ready, policy 'auto', firewall off on s4 for 10.0.4.2, 10.0.0.2");
    SWITCHES.forEach((s) => event("switch", `switch ${s} connected`));
    LINKS.forEach(([a, b]) => event("link", `LLDP: link up ${a}-${b}`));
    st.counters.packet_in = 46; st.counters.flood = 30; st.counters.flow_mod = 6;
    traffic();

    const rttOf = (p) => { // one-way delays of every link on the path, there and back, plus a little queueing noise
      const pathMs = 2 * (1 + 1 + [...linksOf(p)].reduce((a, l) => a + LINKS.find(([x, y]) => key(x, y) === l)[2], 0));
      return pathMs + 0.25 + Math.abs(gauss()) * (pathMs > 40 ? 0.6 : 0.18);
    };
    const lossOf = (p) => 1 - [...linksOf(p)].reduce((ok, l) => ok * (1 - LINKS.find(([x, y]) => key(x, y) === l)[3] / 100) ** 2, 1);

    function measure(count, interval, label, during) {
      const samples = [], rtts = [], lost = [];
      for (let q = 0; q < count; q++) {
        if (during) during(q);
        const p = traffic();
        const blocked = st.firewall || !p;
        if (st.firewall && q === 0) { st.counters.packet_in++; st.counters.drop++; event("firewall", `s4 drop rule: ${SRC} -> ${DST} (firewall on)`); }
        if (blocked || Math.random() < lossOf(p)) { lost.push(q); continue; }
        const r = +rttOf(p).toFixed(3);
        rtts.push(r); samples.push([q, r]);
      }
      const stats = { ...summarize(count, rtts), lost_seq: lost };
      return { mode: "probe", label, target: DST, port: 9000, time: now(), count, interval, stats, samples };
    }
    function setLink(a, b, up) {
      const k = key(a, b);
      if (!(k in st.up)) throw new Error(`no switch link ${a}-${b} in this lab`);
      if (st.up[k] === up) return;
      st.up[k] = up;
      if (!up) {
        const port = `${[a, b].sort()[1]}.${SWITCHES.indexOf([a, b].sort()[0]) + 1}`;
        st.failed_links.push({ link: k, at: now(), reason: `port ${port} down` });
        event("failure", `link FAILED ${k} (port ${port} down)`);
        if (st.path && linksOf(st.path).has(k)) st.failed_paths.push({ conversation: CONV, path: st.path, link: k, at: now() });
        reroute(`link ${k} failed`);
      } else {
        event("link", `LLDP: link up ${k}`);
        reroute(`link ${k} up`);
      }
    }
    function setPolicy(p) {
      st.policy = p;
      event("policy", `route policy now '${p}'`);
      reroute("route policy changed");
    }
    const sim = {
      topology() {
        const p = st.path;
        const alts = candidates();
        return { time: now(), age_s: 0.4, policy: st.policy, firewall: { on: st.firewall, switch: "s4", protected: ["10.0.4.2", "10.0.0.2"] },
          switches: SWITCHES, links: LINKS.filter(([a, b]) => st.up[key(a, b)]).map(([a, b], i) => ({ a, a_port: i + 2, b, b_port: 2 })),
          hosts: [{ mac: "00:00:00:00:00:01", ip: SRC, switch: "s1", port: 1 }, { mac: "00:00:00:00:00:02", ip: DST, switch: "s4", port: 1 }],
          paths: p ? { [CONV]: { switches: p, policy: st.policy, since: st.since } } : {},
          alternatives: { [CONV]: alts }, failed_links: [...st.failed_links], failed_paths: [...st.failed_paths],
          counters: { ...st.counters }, events: [...st.events] };
      },
      status() {
        return { lab: "multipath", busy: st.busy, policy: st.policy, firewall: st.firewall, started: st.started, hosts: { h1: SRC, h2: DST },
          links: LINKS.map(([a, b, d, l, path]) => ({ a, b, up: st.up[key(a, b)], delay_ms: d, loss_pct: l, path })) };
      },
      async route({ policy }) {
        policy = String(policy).trim().split(/\s+/).join(" ");
        if (!POLICY_RE.test(policy)) throw new Error("policy must be 'auto', 'via N' or 'path A B C'");
        setPolicy(policy);
        traffic();
        return sim.status();
      },
      async firewall({ on }) {
        st.firewall = !!on;
        event("firewall", `firewall turned ${on ? "ON" : "off"}`);
        return sim.status();
      },
      async link({ a, b, up }) { setLink(a, b, !!up); traffic(); return sim.status(); },
      async probe({ count = 50, interval = 0.05 }) {
        count = Math.max(1, Math.min(+count, 500));
        await wait(Math.min(1500, 200 + count * 4));
        const probe = measure(count, interval, "web");
        const cmd = `h1$ python3 'netprobe.py' probe ${DST} --count ${count} --interval ${interval} --label web --json 'results/probe_web.json'`;
        return { command: cmd, output: probeText(probe) + "\n", probe, topology: sim.topology() };
      },
      async compare({ count = 40 }) {
        const keep = st.policy, runs = [];
        for (const [name, policy] of POLICIES) {
          setPolicy(policy);
          await wait(250);
          runs.push({ name, policy, probe: measure(count, 0.05, name), topology: sim.topology() });
        }
        setPolicy(keep);
        traffic();
        const a = analyse(runs);
        return { report: render(a), analysis: a };
      },
      async failover() {
        const keep = st.policy, runs = [];
        setPolicy("auto");
        runs.push({ name: "auto", policy: "auto", probe: measure(40, 0.05, "auto"), topology: sim.topology() });
        await wait(400);
        let downAt = null;
        const outage = 12 + Math.floor(Math.random() * 10); // probes lost before the reroute lands
        const probe = measure(300, 0.05, "failover", (q) => {
          if (q === 80) { downAt = q; setLink("s2", "s4", false); }
          if (downAt == null) return;
          if (q < downAt + outage) st.path = ["s1", "s2", "s4"]; // until POX reacts, the old flows still point at the dead link
          else if (q === downAt + outage) st.path = null; // POX has cleared them: the next packet installs the new path
        });
        // the probes sent into the dead link before POX rerouted are lost
        const lostWindow = new Set(Array.from({ length: outage }, (_, i) => 80 + i));
        probe.samples = probe.samples.filter(([q]) => !lostWindow.has(q));
        const rtts = probe.samples.map(([, r]) => r);
        probe.stats = { ...summarize(300, rtts), lost_seq: [...new Set([...probe.stats.lost_seq, ...lostWindow])].sort((x, y) => x - y) };
        st.path = null; traffic();
        runs.push({ name: "failover", policy: "auto", probe, topology: sim.topology(), event: "link s2-s4 taken down 4 s into the run" });
        await wait(600);
        setLink("s2", "s4", true);
        if (keep !== "auto") setPolicy(keep);
        traffic();
        const a = analyse(runs);
        return { report: render(a), analysis: a };
      },
    };
    return sim;
  }

  // ------------------------------------------------------------------ talking to the lab
  let mode = "example", sim = null, labLive = false, busy = false, lastTopo = null, lastCounters = null, lastLab = null, lastPathT;
  let blame = [], peekName = null, corrRuns = []; // correlation results drawn on the topology
  const history = [];

  async function getJSON(url, opts) {
    const r = await fetch(url, { cache: "no-store", ...opts });
    const data = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { status: r.status });
    return data;
  }
  function act(action, body = {}) {
    if (mode === "example") return sim[action](body);
    return getJSON(`api/lab/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }
  async function fetchState() {
    if (mode === "example") return { topo: sim.topology(), lab: sim.status() };
    const [topo, lab] = await Promise.all([getJSON("api/sdn/topology").catch(() => null), getJSON("api/lab/status").catch(() => null)]);
    return { topo, lab };
  }

  // ------------------------------------------------------------------ topology drawing
  function buildTopo() {
    const svg = $("#sdn-topo");
    const line = (a, b, cls, extra = "") => `<line class="${cls}" x1="${POS[a][0]}" y1="${POS[a][1]}" x2="${POS[b][0]}" y2="${POS[b][1]}" ${extra}/>`;
    let h = `<g class="ctl-g">${SWITCHES.map((s) => line("pox", s, "ctl", `data-s="${s}"`)).join("")}</g>`;
    const all = [["h1", "s1", 1, 0], ...LINKS, ["s4", "h2", 1, 0]];
    for (const [a, b, d, l, p] of all) {
      const [x1, y1] = POS[a], [x2, y2] = POS[b];
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      // put the label beside the link, on the side away from the middle of the drawing
      let nx = -(y2 - y1), ny = x2 - x1;
      const len = Math.hypot(nx, ny);
      if ((mx - 380) * nx + (my - 210) * ny < 0 || (y1 === y2 && ny > 0)) { nx = -nx; ny = -ny; }
      const lx = mx + (nx / len) * 18, ly = my + (ny / len) * 18 + 4;
      const label = `${d} ms${l ? ` · ${l}% loss` : ""}`;
      h += `<g class="lk${l ? " lossy" : ""}${p ? " p" + p : ""}" data-k="${key(a, b)}"${p ? ` data-p="${p}"` : ""}>${line(a, b, "halo")}${line(a, b, "base")}${line(a, b, "flow")}` +
        `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle">${label}</text>` +
        `<g class="x" transform="translate(${mx} ${my})"><circle r="9"/><path d="M-4 -4 4 4M4 -4-4 4"/></g></g>`;
    }
    const [px, py] = POS.pox;
    h += `<g class="node pox" id="sdn-pox"><rect x="${px - 105}" y="${py - 24}" width="210" height="48" rx="10"/>` +
      `<text x="${px}" y="${py - 3}" text-anchor="middle" class="t">POX controller</text>` +
      `<text x="${px}" y="${py + 13}" text-anchor="middle" class="s">netpath_controller · OpenFlow 1.0</text>` +
      `<text x="${px + 115}" y="${py + 4}" class="think" id="sdn-think"></text></g>`;
    for (const s of SWITCHES) {
      const [x, y] = POS[s];
      h += `<g class="node sw" data-s="${s}"><rect x="${x - 26}" y="${y - 19}" width="52" height="38" rx="8"/>` +
        `<text x="${x}" y="${y + 1}" text-anchor="middle" class="t">${s}</text><text x="${x}" y="${y + 13}" text-anchor="middle" class="s">dpid ${s.slice(1)}</text></g>`;
    }
    for (const [hname, ip] of [["h1", SRC], ["h2", DST]]) {
      const [x, y] = POS[hname];
      h += `<g class="node host" data-h="${hname}"><rect x="${x - 40}" y="${y - 21}" width="80" height="42" rx="21"/>` +
        `<text x="${x}" y="${y - 2}" text-anchor="middle" class="t">${hname}</text><text x="${x}" y="${y + 12}" text-anchor="middle" class="s">${ip}</text></g>`;
    }
    for (const [name, sx, y] of [["A", 380, 92], ["B", 380, 248], ["C", 380, 333]]) {
      h += `<text class="pname p${name}" data-p="${name}" x="${sx}" y="${y}" text-anchor="middle">path ${name}</text>`;
    }
    svg.innerHTML = h + `<g id="sdn-anim"></g>`;
  }

  function drawTopo(topo, lab) {
    const svg = $("#sdn-topo");
    const discovered = new Set(((topo && topo.links) || []).map((l) => key(l.a, l.b)));
    const connected = new Set((topo && topo.switches) || []);
    const path = topo ? convPath(topo, SRC, DST) : null;
    const on = linksOf(path ? ["h1", ...path, "h2"] : null);
    const down = new Set(((lab && lab.links) || []).filter((l) => !l.up).map((l) => key(l.a, l.b)));
    const hostsSeen = new Set(((topo && topo.hosts) || []).map((h) => h.ip));
    svg.querySelectorAll(".lk").forEach((g) => {
      const k = g.dataset.k, isHost = k.includes("h");
      g.classList.toggle("on", on.has(k));
      g.classList.toggle("down", down.has(k));
      g.classList.toggle("unseen", !!topo && !isHost && !discovered.has(k) && !down.has(k));
    });
    svg.querySelectorAll(".node.sw").forEach((g) => g.classList.toggle("off", !!topo && !connected.has(g.dataset.s)));
    svg.querySelectorAll(".ctl").forEach((l) => l.classList.toggle("off", !topo || !connected.has(l.dataset.s)));
    svg.querySelectorAll(".node.host").forEach((g) => g.classList.toggle("off", !!topo && !hostsSeen.has(g.dataset.h === "h1" ? SRC : DST)));
    const pname = pathName(path);
    svg.querySelectorAll(".pname").forEach((t) => t.classList.toggle("on", t.dataset.p === pname));
    // host links take the colour of the path in use (or the one a table row points at)
    svg.style.setProperty("--pcol", PCOL[peekName || pname] || "var(--mod)");
    const blamed = new Map(blame.flatMap((b) => b.links.map((l) => [l, b])));
    svg.querySelectorAll(".lk").forEach((g) => g.classList.toggle("blame", blamed.has(g.dataset.k)));
    svg.querySelectorAll(".pname").forEach((t) => {
      const b = blame.find((x) => x.name === t.dataset.p);
      t.textContent = `path ${t.dataset.p}${b ? " · " + b.text : ""}`;
    });
    svg.classList.toggle("fw", !!(topo && topo.firewall && topo.firewall.on));
    const alts = topo && topo.alternatives ? topo.alternatives[CONV] || topo.alternatives[`${DST}->${SRC}`] : null;
    $("#sdn-path").innerHTML = path ? `<b>${esc(pathStr(path))}</b> · path ${badge(pname) || "?"} · policy <code>${esc(topo.policy || "auto")}</code>` :
      alts && !alts.length ? `<b>no path:</b> every route between h1 and h2 has a failed link` : "no active path yet (send some traffic)";
  }

  function pulsePox(counters) {
    if (lastCounters && counters && (counters.packet_in !== lastCounters.packet_in || counters.flow_mod !== lastCounters.flow_mod)) {
      const pox = $("#sdn-pox");
      pox.classList.remove("pulse"); void pox.getBBox(); pox.classList.add("pulse");
    }
    lastCounters = counters;
  }

  // ------------------------------------------------------------------ controller animation
  // Replays what the OpenFlow messages did, on the drawing: LLDP discovery, and packet-in -> flow-mod for a new flow.
  const SVGNS = "http://www.w3.org/2000/svg";
  const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const at = (n) => (n === "pox" ? [POS.pox[0], POS.pox[1] + 22] : POS[n]);
  let seqRun = 0;

  function showSeq(title, steps) {
    $("#sdn-seq-title").innerHTML = title;
    $("#sdn-seq").innerHTML = steps.map(([k, t]) => `<li><code>${k}</code><span>${t}</span></li>`).join("");
  }
  function stepTo(i) {
    $("#sdn-seq").querySelectorAll("li").forEach((li, j) => { li.classList.toggle("done", j < i); li.classList.toggle("now", j === i); });
  }
  const think = (t) => ($("#sdn-think").textContent = t);
  const lit = (s, on = true) => { const g = $(`#sdn-topo .node.sw[data-s="${s}"]`); if (g) g.classList.toggle("lit", on); };
  function settle() {
    think("");
    SWITCHES.forEach((s) => lit(s, false));
    $("#sdn-topo").querySelectorAll(".lk.found").forEach((g) => g.classList.remove("found"));
    stepTo(99);
  }
  const pause = (ms, t) => (t === seqRun ? wait(still() ? ms / 3 : ms) : Promise.resolve());
  function fly(a, b, cls, ms, t) {
    if (t !== seqRun) return Promise.resolve();
    if (still()) return wait(ms / 3);
    const [x1, y1] = at(a), [x2, y2] = at(b);
    const c = document.createElementNS(SVGNS, "circle");
    c.setAttribute("r", cls === "data" ? 7 : 5.5);
    c.setAttribute("class", "pkt " + cls);
    $("#sdn-anim").appendChild(c);
    return new Promise((done) => {
      const t0 = performance.now();
      (function frame(now) {
        const k = Math.min(1, (now - t0) / ms), e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
        c.setAttribute("cx", (x1 + (x2 - x1) * e).toFixed(1));
        c.setAttribute("cy", (y1 + (y2 - y1) * e).toFixed(1));
        if (k < 1 && t === seqRun) requestAnimationFrame(frame);
        else { c.remove(); done(); }
      })(t0);
    });
  }

  const flowSteps = (path, policy, n) => [
    ["packet-in", `h1's first packet to h2 matches no rule on s1, so s1 sends it up to POX.`],
    ["candidate_paths", `POX lists the loop-free paths s1 → s4 in its LLDP link map: ${n} found.`],
    ["choose_path", `Policy <code>${esc(policy)}</code> picks path ${badge(pathName(path))} ${path.join(" → ")}.`],
    ["flow-mod", `One rule per switch, far end first (${[...path].reverse().join(", ")}), so the packet never outruns its rules.`],
    ["packet-out", `POX releases the held packet on s1. It follows the new rules to h2, and later packets never reach POX.`],
  ];
  async function playFlow(path, policy, n) {
    const t = ++seqRun;
    settle();
    showSeq(`New flow h1 → h2: how POX installed path ${badge(pathName(path))}`, flowSteps(path, policy, n));
    stepTo(0);
    await fly("h1", "s1", "data", 450, t);
    lit("s1");
    await fly("s1", "pox", "pin", 600, t);
    stepTo(1); think(`candidate_paths() → ${n}`); await pause(900, t);
    stepTo(2); think(`choose_path('${policy}') → ${pathName(path)}`); await pause(900, t);
    stepTo(3); think("");
    for (const s of [...path].reverse()) { await fly("pox", s, "fmod", 420, t); lit(s); }
    stepTo(4);
    await fly("pox", "s1", "fmod", 420, t);
    const hops = ["s1", ...path.slice(1), "h2"];
    for (let i = 1; i < hops.length; i++) await fly(hops[i - 1], hops[i], "data", 380, t);
    if (t === seqRun) settle();
  }

  async function playLLDP(topo) {
    const t = ++seqRun;
    settle();
    const links = topo ? [...new Map(topo.links.map((l) => [key(l.a, l.b), [l.a, l.b]])).values()] : LINKS.map(([a, b]) => [a, b]);
    const alts = (topo && topo.alternatives && topo.alternatives[CONV]) || [];
    const switches = (topo && topo.switches) || SWITCHES;
    showSeq("Topology discovery: how POX found the network", [
      ["connect", `Each switch opens an OpenFlow connection to POX on port 6633: ${switches.length} switches connected.`],
      ["LLDP out", `<code>openflow.discovery</code> sends an LLDP frame out of every switch port (packet-out).`],
      ["LLDP in", `The switch at the far end has no rule for LLDP, so it passes the frame back to POX (packet-in). That proves the link exists.`],
      ["link map", `POX now has ${links.length} switch links and ${alts.length} loop-free paths s1 → s4. Hosts are learned from the port their first packet arrives on.`],
    ]);
    stepTo(0);
    await Promise.all(switches.map((s) => fly(s, "pox", "fmod", 650, t).then(() => lit(s))));
    stepTo(1);
    await Promise.all(links.map(([a]) => fly("pox", a, "lldp", 550, t)));
    await Promise.all(links.map(([a, b]) => fly(a, b, "lldp", 650, t)));
    stepTo(2);
    await Promise.all(links.map(([, b]) => fly(b, "pox", "pin", 600, t)));
    if (t !== seqRun) return;
    stepTo(3);
    links.forEach(([a, b]) => { const g = $(`#sdn-topo .lk[data-k="${key(a, b)}"]`); if (g) g.classList.add("found"); });
    think(`${links.length} links · ${alts.length} paths`);
    await pause(1600, t);
    if (t === seqRun) settle();
  }

  // a new "path" event in the controller log means POX just installed a flow: show how
  function watchFlows(topo) {
    const ev = ((topo && topo.events) || []).filter((e) => e.kind === "path");
    const latest = ev.length ? ev[ev.length - 1].t : 0;
    const first = lastPathT === undefined;
    if (!first && latest > lastPathT) {
      const path = convPath(topo, SRC, DST);
      if (path) playFlow(path, topo.policy || "auto", ((topo.alternatives || {})[CONV] || []).length);
    }
    lastPathT = latest;
  }

  // ------------------------------------------------------------------ correlation on the drawing
  function blameFrom(a) {
    return a.runs.filter((r) => !r.event && r.name !== a.best && r.explained_by && r.explained_by.links.length).map((r) => {
      const e = r.explained_by, parts = [];
      if (e.extra_ms != null && Math.abs(e.extra_ms) >= 1) parts.push(`${e.extra_ms > 0 ? "+" : ""}${e.extra_ms.toFixed(0)} ms`);
      if (e.extra_loss_pct >= 1) parts.push(`+${e.extra_loss_pct.toFixed(0)}% loss`);
      return parts.length ? { name: pathName(r.path), run: r.name, links: e.links, text: parts.join(", ") } : null;
    }).filter(Boolean);
  }
  function renderBlame(a) {
    blame = blameFrom(a);
    const best = a.runs.find((r) => r.name === a.best);
    $("#sdn-blame").innerHTML = blame.length ?
      `<span>Correlation, against the best path ${badge(pathName(best && best.path))}:</span>` +
      blame.map((b) => `<span>${badge(b.name)} ${esc(b.text)} from <b>${esc(b.links.join(", "))}</b></span>`).join("") +
      `<span class="c-dim">Point at a row of the correlation table to see its path here.</span>` : "";
    drawTopo(lastTopo, lastLab);
  }
  function peek(path) {
    const svg = $("#sdn-topo");
    const ks = linksOf(path ? ["h1", ...path, "h2"] : null);
    peekName = pathName(path);
    svg.classList.toggle("peeking", !!path);
    svg.querySelectorAll(".lk").forEach((g) => g.classList.toggle("peek", ks.has(g.dataset.k)));
    svg.querySelectorAll(".pname").forEach((t) => t.classList.toggle("peek", t.dataset.p === peekName));
    svg.style.setProperty("--pcol", PCOL[peekName || pathName(convPath(lastTopo, SRC, DST))] || "var(--mod)");
  }

  // ------------------------------------------------------------------ panels
  function renderCounters(topo) {
    const c = (topo && topo.counters) || {};
    const n = (v) => (v == null ? "-" : v);
    const cells = [
      ["switches", topo ? topo.switches.length : "-"], ["links", topo ? new Set(topo.links.map((l) => key(l.a, l.b))).size : "-"],
      ["hosts", topo ? topo.hosts.filter((h) => h.ip).length : "-"], ["packet-in", n(c.packet_in)], ["flow-mod", n(c.flow_mod)],
      ["flood", n(c.flood)], ["drop", n(c.drop)], ["reroute", n(c.reroute)],
    ];
    $("#sdn-counters").innerHTML = cells.map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("");
  }

  function renderEvents(topo) {
    const ev = (topo && topo.events) || [];
    const box = $("#sdn-events");
    if (!ev.length) { box.innerHTML = `<span class="c-dim">No controller events yet.</span>`; return; }
    const warn = new Set(["failure", "firewall", "policy", "warn"]);
    box.innerHTML = ev.slice(-40).map((e) => `<span class="${warn.has(e.kind) ? "c-warn" : e.kind === "path" ? "c-vio" : ""}">` +
      `<span class="c-dim">${clock(e.t)}</span> ${esc(e.kind.padEnd(8))} ${esc(e.text)}</span>`).join("\n");
    box.scrollTop = box.scrollHeight;
  }

  function renderFailures(topo) {
    const fl = (topo && topo.failed_links) || [], fp = (topo && topo.failed_paths) || [];
    const rows = [
      ...fl.slice(-6).reverse().map((l) => `<tr><td>${clock(l.at)}</td><td><span class="tag bad">link</span> ${esc(l.link)}</td><td>${esc(l.reason)}</td></tr>`),
      ...fp.slice(-6).reverse().map((p) => `<tr><td>${clock(p.at)}</td><td><span class="tag warn">path</span> ${esc(p.path.join(" → "))}</td><td>${esc(p.conversation)} used ${esc(p.link)}, rerouted</td></tr>`),
    ];
    $("#sdn-failed").innerHTML = rows.length ? rows.join("") : `<tr><td colspan="3" class="empty-cell">No failures seen. Take a link down, or run the failure test.</td></tr>`;
  }

  function renderLinks(lab) {
    const box = $("#sdn-links");
    const links = (lab && lab.links) || LINKS.map(([a, b, d, l, path]) => ({ a, b, up: true, delay_ms: d, loss_pct: l, path }));
    box.innerHTML = links.map((l) => `<button class="chip lk-chip${l.up ? "" : " is-down"}" data-a="${l.a}" data-b="${l.b}" data-up="${l.up}">` +
      `${l.a}–${l.b} <span>${l.up ? "up" : "down"}</span></button>`).join("");
    setControls();
  }

  function renderStatus(topo, lab) {
    const pox = $("#sdn-pox-status"), mn = $("#sdn-mn-status"), src = $("#sdn-mode");
    if (mode === "example") {
      pox.className = "status-pill"; pox.textContent = "POX: example";
      mn.className = "status-pill"; mn.textContent = "Mininet: example";
    } else {
      const stale = topo && topo.age_s > 10;
      pox.className = "status-pill " + (topo ? (stale ? "run" : "ok") : "bad");
      pox.textContent = topo ? (stale ? `POX: stale ${Math.round(topo.age_s)} s` : "POX: live") : "POX: offline";
      mn.className = "status-pill " + (lab ? (lab.busy ? "run" : "ok") : "bad");
      mn.textContent = lab ? (lab.busy ? `Mininet: ${lab.busy}…` : "Mininet: live") : "Mininet: offline";
    }
    src.textContent = mode === "example" ? "Example mode: a simulated copy of the lab, not real measurements" : "Live: data from the POX controller and Mininet on this machine";
    $("#sdn-offline").hidden = mode !== "example";
    if (lab) {
      policySeg.setQuiet(lab.policy);
      fwSeg.setQuiet(lab.firewall ? "on" : "off");
    }
    setControls();
  }
  const labUsable = () => mode === "example" || labLive;
  function setControls() {
    document.querySelectorAll("#sdn .needs-lab, #sdn .lk-chip").forEach((b) => (b.disabled = busy || !labUsable()));
    $("#sdn-lab-hint").hidden = labUsable();
  }

  async function refresh() {
    let topo, lab;
    try { ({ topo, lab } = await fetchState()); } catch (e) { topo = lab = null; }
    labLive = !!lab;
    lastTopo = topo;
    lastLab = lab;
    drawTopo(topo, lab);
    pulsePox(topo && topo.counters);
    watchFlows(topo);
    renderCounters(topo);
    renderEvents(topo);
    renderFailures(topo);
    if (!busy) renderLinks(lab);
    renderStatus(topo, lab);
  }

  // ------------------------------------------------------------------ measurements
  function renderProbe(res) {
    const s = res.probe.stats, path = convPath(res.topology, SRC, DST);
    $("#sdn-probe-stats").innerHTML = [
      ["sent", s.sent], ["received", s.received], ["loss", `${s.loss_pct}<small>%</small>`, s.loss_pct >= 5 ? "bad" : s.loss_pct > 0 ? "warn" : "ok"],
      ["avg rtt", `${f2(s.avg_ms)}<small>ms</small>`], ["jitter", `${f2(s.jitter_ms)}<small>ms</small>`], ["min / max", `${f2(s.min_ms)}<small> / ${f2(s.max_ms)}</small>`],
    ].map(([k, v, c]) => `<div class="stat ${c || ""}"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("");
    $("#sdn-probe-term").innerHTML = `<span class="c-dim">${esc(res.command)}</span>\n${esc(res.output.trim())}\n<span class="c-vio">POX path for this run: ${esc(pathStr(path))}</span>`;
    drawSamples(res.probe);
    history.unshift({ t: res.probe.time, policy: (res.topology && res.topology.policy) || "?", path, stats: s, fw: !!(res.topology && res.topology.firewall && res.topology.firewall.on) });
    $("#sdn-history").innerHTML = history.slice(0, 12).map((h) => {
      const name = pathName(h.path);
      const verdict = !h.stats.received ? `<span class="tag bad">${h.fw ? "blocked" : "failed"}</span>` : h.stats.loss_pct >= 5 ? `<span class="tag warn">lossy</span>` : h.stats.avg_ms > 40 ? `<span class="tag warn">slow</span>` : `<span class="tag ok">ok</span>`;
      return `<tr><td>${clock(h.t)}</td><td>${esc(h.policy)}</td><td>${badge(name)} ${esc(h.path ? h.path.join("→") : "-")}</td>` +
        `<td class="num">${f2(h.stats.avg_ms)}</td><td class="num">${f2(h.stats.jitter_ms)}</td><td class="num">${h.stats.loss_pct}</td><td>${verdict}</td></tr>`;
    }).join("");
  }

  function drawSamples(p) {
    const W = 640, H = 170, L = 44, R = 10, T = 12, B = 26;
    const count = p.count || p.stats.sent, rtts = p.samples.map((x) => x[1]);
    const max = Math.max(10, ...rtts) * 1.15;
    const x = (q) => L + ((W - L - R) * (q + 0.5)) / count, y = (v) => T + (H - T - B) * (1 - v / max);
    const ticks = [0, max / 2, max].map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="g"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v.toFixed(0)}</text>`).join("");
    const pts = p.samples.map(([q, r]) => `${x(q).toFixed(1)},${y(r).toFixed(1)}`).join(" ");
    const lost = (p.stats.lost_seq || []).map((q) => `<line class="lost" x1="${x(q)}" x2="${x(q)}" y1="${H - B}" y2="${H - B + 7}"/>`).join("");
    $("#sdn-chart").innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="chart sdn-chart" role="img" aria-label="RTT of each UDP probe">${ticks}` +
      `<polyline points="${pts}" class="ln"/>${p.samples.length < 120 ? p.samples.map(([q, r]) => `<circle cx="${x(q)}" cy="${y(r)}" r="2.3" class="pt"/>`).join("") : ""}${lost}` +
      `<text x="${L}" y="${H - 6}">probe 0</text><text x="${W - R}" y="${H - 6}" text-anchor="end">probe ${count - 1} · ticks below the axis = lost probes</text>` +
      `<text x="8" y="${T + 4}">ms</text></svg>`;
  }

  function renderCorrelation(res, title) {
    const a = res.analysis;
    $("#sdn-corr-title").textContent = title;
    const best = a.runs.find((r) => r.name === a.best);
    corrRuns = a.runs;
    $("#sdn-corr").innerHTML = a.runs.map((r, i) => {
      const s = r.stats, e = r.explained_by;
      const why = r.event ? esc(r.event) : r.name === a.best ? `<span class="tag ok">best</span>` : e && e.links.length ?
        `${e.extra_ms != null && Math.abs(e.extra_ms) >= 1 ? `${e.extra_ms > 0 ? "+" : ""}${e.extra_ms.toFixed(1)} ms ` : ""}${e.extra_loss_pct >= 1 ? `+${e.extra_loss_pct.toFixed(1)}% loss ` : ""}from <b>${esc(e.links.join(", "))}</b>` :
        "same links as the best path";
      const cls = { OK: "ok", LOSSY: "warn", SLOW: "warn", FAILED: "bad" }[r.status];
      return `<tr data-run="${i}"><td>${esc(r.name)}</td><td>${badge(pathName(r.path))} ${esc(r.path ? r.path.join("→") : "-")}</td><td class="num">${f2(s.avg_ms)}</td><td class="num">${f2(s.jitter_ms)}</td>` +
        `<td class="num">${s.loss_pct.toFixed(1)}</td><td class="num">${score(s) === Infinity ? "∞" : score(s).toFixed(1)}</td><td><span class="tag ${cls}">${r.status}</span></td><td class="why">${why}</td></tr>`;
    }).join("");
    const f = a.failure;
    let rec = best ? `Best path <b>${esc(pathStr(best.path))}</b>: ${f2(best.stats.avg_ms, " ms")}, ${best.stats.loss_pct}% loss. Ranking by delay + ${LOSS_WEIGHT_MS} ms per 1% loss: ${esc(a.ranking.join(", "))}.` : "";
    if (f) {
      const longest = f.outages.length ? f.outages.reduce((m, o) => (o[2] > m[2] ? o : m)) : null;
      rec += ` <br />Failure: ${esc(pathStr(f.path_before))} failed on ${esc((f.failed_links[0] || {}).link || "s2-s4")}; POX rerouted to ${esc(pathStr(f.path_after))}` +
        (longest ? `. Traffic stopped for about <b>${pyFloat(longest[2])} s</b> (probes ${longest[0]}–${longest[1]}).` : ", with no probes lost.");
    }
    $("#sdn-corr-rec").innerHTML = rec;
    $("#sdn-report").textContent = res.report;
    renderBlame(a);
    $("#sdn-corr-wrap").hidden = false;
    $("#sdn-corr-empty").hidden = true;
  }

  // ------------------------------------------------------------------ routed lab (topology.py): what traceroute sees
  // h1 ─ s1 ─ r1 ─ s2 ─ r2 ─ s3 ─ r3 ─ s4 ─ h2. Every link adds 1 ms each way, s3–r3 adds 30 ms, s4–h2 drops 15%.
  const RT_DST = "10.0.4.2";
  const ROUTED = [[1, "10.0.1.1", "r1", 4], [2, "10.0.2.2", "r2", 8], [3, "10.0.3.2", "r3", 70], [4, RT_DST, "h2", 74]];
  const RT_NODE = Object.fromEntries(ROUTED.map(([, ip, n]) => [ip, n]));
  const JUMP_MS = 50, LOSS_THRESH = 20; // analyze_path() defaults
  let routed = null;

  function routedExample() {
    const lossy = 1 - 0.85 ** 2; // the last-mile loss hits the probe and the reply
    const hops = ROUTED.map(([hop, ip, , base]) => ({ hop, ip, rtts: [0, 1, 2].map(() =>
      hop === 4 && Math.random() < lossy ? null : +(base + 0.06 + Math.abs(gauss()) * (base > 50 ? 0.35 : 0.12)).toFixed(3)) }));
    if (hops[3].rtts.every((r) => r === null)) hops[3].rtts[1] = 74.21;
    const text = `traceroute to ${RT_DST} (${RT_DST}), 30 hops max, 60 byte packets\n` + hops.map((h) => {
      let shown = false;
      const parts = h.rtts.map((r) => (r === null ? "*" : (shown ? "" : ((shown = true), h.ip + "  ")) + r.toFixed(3) + " ms"));
      return `${String(h.hop).padStart(2)}  ${parts.join("  ")}`;
    }).join("\n");
    return { hops, text, file: null };
  }
  // traceroute -n output: " 3  10.0.3.2  70.412 ms  70.388 ms *"
  function parseTraceroute(text) {
    const hops = [];
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(.*)$/);
      if (!m) continue;
      const toks = m[2].trim().split(/\s+/), rtts = [];
      let ip = null;
      for (let i = 0; i < toks.length; i++) {
        if (toks[i] === "*") rtts.push(null);
        else if (/^\d+(\.\d+){3}$/.test(toks[i])) ip = ip || toks[i];
        else if (/^\d+(\.\d+)?$/.test(toks[i]) && toks[i + 1] === "ms") { rtts.push(+toks[i]); i++; }
      }
      hops.push({ hop: +m[1], ip, rtts });
    }
    return hops;
  }
  function hopStats(hops) {
    let prev = null;
    return hops.map((h) => {
      const got = h.rtts.filter((r) => r !== null);
      const avg = got.length ? got.reduce((a, b) => a + b, 0) / got.length : null;
      const loss = h.rtts.length ? (100 * (h.rtts.length - got.length)) / h.rtts.length : 100;
      const delta = avg != null && prev != null ? avg - prev : null;
      if (avg != null) prev = avg;
      return { ...h, avg, loss, delta, jump: delta != null && delta > JUMP_MS, lossy: loss > 0 && loss < 100 && loss >= LOSS_THRESH };
    });
  }

  function drawRouted() {
    const st = hopStats(routed.hops);
    const X = { h1: 45, s1: 135, r1: 225, s2: 315, r2: 405, s3: 495, r3: 585, s4: 675, h2: 755 }, Y = 78;
    const chain = ["h1", "s1", "r1", "s2", "r2", "s3", "r3", "s4", "h2"];
    let h = "";
    chain.slice(1).forEach((n, i) => {
      const a = chain[i], cls = a === "s3" ? "wire slow" : a === "s4" ? "wire lossy" : "wire";
      h += `<line class="${cls}" x1="${X[a]}" y1="${Y}" x2="${X[n]}" y2="${Y}"/>`;
    });
    h += `<text class="note warn" x="${(X.s3 + X.r3) / 2}" y="${Y + 34}" text-anchor="middle">+30 ms each way</text>`;
    h += `<text class="note bad" x="${(X.s4 + X.h2) / 2 - 8}" y="${Y + 34}" text-anchor="middle">15% loss</text>`;
    for (const n of chain) {
      const x = X[n];
      if (n[0] === "s") h += `<g class="sw"><rect x="${x - 17}" y="${Y - 12}" width="34" height="24" rx="5"/><text x="${x}" y="${Y + 4}" text-anchor="middle">${n}</text></g>`;
      else if (n[0] === "r") h += `<g class="rt"><rect x="${x - 30}" y="${Y - 20}" width="60" height="40" rx="8"/><text class="t" x="${x}" y="${Y + 5}" text-anchor="middle">${n}</text></g>`;
      else h += `<g class="host"><rect x="${x - 34}" y="${Y - 20}" width="68" height="40" rx="20"/><text class="t" x="${x}" y="${Y + 5}" text-anchor="middle">${n}</text></g>`;
    }
    // hop labels above, RTT bars below: one per address that answered
    const base = 230, top = 140, max = Math.max(10, ...st.map((s) => s.avg || 0)) * 1.1;
    h += `<line class="ax" x1="160" x2="790" y1="${base}" y2="${base}"/>`;
    h += `<text x="20" y="${top + 4}">avg RTT</text><text x="20" y="${top + 18}">per hop</text>`;
    for (const s of st) {
      const n = RT_NODE[s.ip] || null, x = n ? X[n] : null;
      if (x == null) continue;
      const cls = s.jump ? "hop jump" : s.lossy ? "hop loss" : "hop";
      h += `<text class="${cls}" x="${x}" y="22" text-anchor="middle">hop ${s.hop}</text>`;
      h += `<text x="${x}" y="40" text-anchor="middle">${esc(s.ip)}</text>`;
      if (s.avg == null) continue;
      const bh = ((base - top) * s.avg) / max;
      h += `<rect class="bar${s.jump ? " jump" : ""}" x="${x - 18}" y="${(base - bh).toFixed(1)}" width="36" height="${bh.toFixed(1)}" rx="3"/>`;
      h += `<text x="${x}" y="${(base - bh - 6).toFixed(1)}" text-anchor="middle">${s.avg.toFixed(1)} ms</text>`;
      if (s.jump) h += `<text class="note warn" x="${x - 70}" y="${(base - bh / 2).toFixed(1)}" text-anchor="middle">+${s.delta.toFixed(0)} ms jump</text>`;
      if (s.lossy) h += `<text class="note bad" x="${x}" y="${base + 16}" text-anchor="middle">${s.loss.toFixed(0)}% lost</text>`;
    }
    $("#rt-chain").innerHTML = h;

    const verdict = (s) => (s.avg == null ? `<span class="tag bad">silent</span>` : s.jump ? `<span class="tag warn">latency jump</span>` : s.lossy ? `<span class="tag bad">packet loss</span>` : `<span class="tag ok">ok</span>`);
    $("#rt-table").innerHTML = st.map((s) => `<tr><td>${s.hop}</td><td>${esc(s.ip || "*")}</td><td>${esc(RT_NODE[s.ip] || "?")}</td>` +
      `<td>${s.rtts.map((r) => (r === null ? "*" : r.toFixed(2))).join("  ")}</td><td class="num">${f2(s.avg)}</td>` +
      `<td class="num">${s.delta == null ? "-" : (s.delta >= 0 ? "+" : "") + s.delta.toFixed(2)}</td><td class="num">${s.loss.toFixed(0)}</td><td>${verdict(s)}</td></tr>`).join("");
    $("#rt-term").textContent = `h1$ traceroute -n -q 3 -w 2 ${RT_DST}\n${routed.text.trim()}`;
    const last = routed.hops[routed.hops.length - 1];
    const path = { target: RT_DST, reached: !!last && last.ip === RT_DST, hops: routed.hops };
    $("#rt-analyse").href = NP.pageUrl("analysis.html", { path: JSON.stringify(path) });
    const src = $("#rt-source");
    if (routed.file) {
      src.className = "status-pill ok";
      src.textContent = `Recorded run: ${routed.file}${routed.mtime ? " · " + new Date(routed.mtime * 1000).toLocaleString() : ""}`;
    } else {
      src.className = "status-pill";
      src.textContent = "Example: simulated from topology.py's link settings";
    }
    $("#rt-again").hidden = !!routed.file;
    $("#rt-note").hidden = !!routed.file;
  }

  async function loadRouted() {
    const rec = await getJSON("api/sdn/routed").catch(() => null);
    const hops = rec && rec.text ? parseTraceroute(rec.text) : [];
    routed = hops.length ? { hops, text: rec.text, file: rec.file, mtime: rec.mtime } : routedExample();
    drawRouted();
  }

  // ------------------------------------------------------------------ controls
  let policySeg, fwSeg;
  function quietSeg(el, onChange) { // NP.seg, plus a way to show the lab's state without sending it back
    let quiet = false;
    const seg = NP.seg(el, (v) => { if (!quiet) onChange(v); });
    seg.setQuiet = (v) => { if (!el.querySelector(`[data-val="${v}"]`)) return; quiet = true; seg.set(v); quiet = false; };
    return seg;
  }

  async function run(label, fn) {
    if (busy) return;
    busy = true;
    const pill = $("#sdn-run");
    pill.className = "status-pill run"; pill.textContent = label + "…";
    setControls();
    try {
      await fn();
      pill.className = "status-pill ok"; pill.textContent = "done";
    } catch (e) {
      pill.className = "status-pill bad"; pill.textContent = "error";
      $("#sdn-error").textContent = e.status === 503 ? "The lab isn't running. Start it with: sudo python3 sdn/multipath.py --serve" : e.message;
      setTimeout(() => ($("#sdn-error").textContent = ""), 8000);
    } finally {
      busy = false;
      setControls();
      refresh();
    }
  }

  let modeShown = null;
  function setMode(m) {
    mode = m;
    if (m === modeShown) return refresh(); // the live check confirmed the mode already showing: keep the results
    modeShown = m;
    if (m === "example" && !sim) sim = makeSim();
    history.length = 0;
    $("#sdn-history").innerHTML = "";
    lastPathT = undefined;
    blame = []; corrRuns = [];
    $("#sdn-blame").innerHTML = "";
    $("#sdn-corr-wrap").hidden = true;
    $("#sdn-corr-empty").hidden = false;
    refresh();
  }

  function init() {
    buildTopo();
    policySeg = quietSeg($("#sdn-policy"), (v) => run("route " + v, () => act("route", { policy: v })));
    fwSeg = quietSeg($("#sdn-fw"), (v) => run("firewall " + v, () => act("firewall", { on: v === "on" })));
    const count = $("#sdn-count");
    count.addEventListener("input", () => ($("#sdn-count-o").textContent = count.value));
    $("#sdn-links").addEventListener("click", (e) => {
      const b = e.target.closest(".lk-chip");
      if (b && !b.disabled) run(`link ${b.dataset.a}-${b.dataset.b}`, () => act("link", { a: b.dataset.a, b: b.dataset.b, up: b.dataset.up !== "true" }));
    });
    $("#sdn-probe").addEventListener("click", () => run("probing", async () => renderProbe(await act("probe", { count: +count.value, interval: 0.05 }))));
    $("#sdn-compare").addEventListener("click", () => run("comparing paths", async () => renderCorrelation(await act("compare", { count: 40 }), "Path comparison: auto, A, B and C measured in turn")));
    $("#sdn-failover").addEventListener("click", () => run("failure test", async () => renderCorrelation(await act("failover"), "Failure test: link s2–s4 taken down mid-run")));
    $("#sdn-corr").addEventListener("mouseover", (e) => { const tr = e.target.closest("tr[data-run]"); if (tr && corrRuns[+tr.dataset.run]) peek(corrRuns[+tr.dataset.run].path); });
    $("#sdn-corr").addEventListener("mouseleave", () => peek(null));
    $("#sdn-replay-flow").addEventListener("click", () => {
      const path = convPath(lastTopo, SRC, DST);
      if (path) playFlow(path, lastTopo.policy || "auto", ((lastTopo.alternatives || {})[CONV] || []).length);
      else { showSeq("New flow h1 → h2", [["no path", "POX has no path for h1 → h2 right now. Restore a link or send some traffic first."]]); stepTo(0); }
    });
    $("#sdn-replay-lldp").addEventListener("click", () => playLLDP(lastTopo));
    showSeq("Topology discovery: how POX found the network", [["…", "Scroll the diagram into view to watch the replay."]]);
    // play discovery once, the first time the diagram is on screen
    const io = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) { io.disconnect(); setTimeout(() => playLLDP(lastTopo), 400); } }, { threshold: 0.6 });
    io.observe($("#sdn-topo"));
    $("#rt-again").addEventListener("click", () => { routed = routedExample(); drawRouted(); });
    loadRouted();
    const source = NP.seg($("#sdn-source"), (v) => setMode(v));
    setMode("example");
    // Live when serve.py can see the controller or the lab; otherwise the example model.
    Promise.all([getJSON("api/sdn/topology").catch(() => null), getJSON("api/lab/status").catch(() => null)]).then(([topo, lab]) => {
      const live = !!(topo || lab);
      source.set(live ? "live" : "example");
    });
    setInterval(() => { if (!document.hidden) refresh(); }, 2000);
  }

  NP.sdn = { init, analyse, render, summarize, makeSim };
})();
