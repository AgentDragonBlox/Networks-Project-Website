/* Port of traceroute/traceroute.py — validate_target, build_command, parse_traceroute_output, run_traceroute
   (result assembly), format_result and to_dict — plus a TTL explainer and a simulated network. */
(function () {
  const { $, $$, esc } = NP;

  const DEFAULT_MAX_HOPS = 30, MAX_ALLOWED_HOPS = 64, MAX_ALLOWED_QUERIES = 10, MAX_TARGET_LENGTH = 253;
  const LESS_THAN_ONE_MS_VALUE = 1.0, SUBPROCESS_GRACE_SECONDS = 10;

  const HOP_LINE_RE = /^\s*(\d+)\s+(.*)$/;
  const TOKEN_RE = /(?<star>\*)|(?<rtt><?\d+(?:\.\d+)?)\s*ms\b|(?<ipv4>\b(?:\d{1,3}\.){3}\d{1,3}\b)|(?<ipv6>(?<![\w:])[0-9a-fA-F]{0,4}(?::[0-9a-fA-F]{0,4}){2,7}(?![\w:]))/g;
  const HEADER_DEST_RE = /(?:traceroute(?:6)? to|Tracing route to)\s+\S+\s+[\[(]([0-9a-fA-F.:]+)[\])]/i;
  const TARGET_RE = /^[A-Za-z0-9.:\-]+$/;

  // ================= ported logic =================
  function validateTarget(raw) {
    const checks = [];
    const t = String(raw).trim();
    const add = (ok, label) => (checks.push({ ok, label }), ok);
    let error = null;
    if (!add(t.length > 0, "Not empty after strip()")) error = "Target must not be empty.";
    else if (!add(t.length <= MAX_TARGET_LENGTH, `At most ${MAX_TARGET_LENGTH} characters (${t.length})`)) error = `Target is longer than ${MAX_TARGET_LENGTH} characters.`;
    else if (!add(!t.startsWith("-"), "Does not start with '-' (blocks option injection)")) error = "Target must not start with '-'.";
    else if (!add(TARGET_RE.test(t), "Only letters, digits, '.', ':' and '-'")) error = "Target may only contain letters, digits, '.', ':' and '-'.";
    const labels = ["Not empty after strip()", `At most ${MAX_TARGET_LENGTH} characters`, "Does not start with '-' (blocks option injection)", "Only letters, digits, '.', ':' and '-'"];
    while (checks.length < 4) checks.push({ ok: null, label: labels[checks.length] });
    return { target: t, error, checks };
  }

  function buildCommand(target, maxHops, timeout, queries, os) {
    if (os === "windows") return ["tracert", "-d", "-h", String(maxHops), "-w", String(Math.max(1, Math.trunc(timeout * 1000))), target];
    const ts = Number.isInteger(timeout) ? String(timeout) : String(timeout);
    return ["traceroute", "-n", "-m", String(maxHops), "-q", String(queries), "-w", ts, target];
  }

  function parseRtt(tok) {
    return tok.startsWith("<") ? LESS_THAN_ONE_MS_VALUE : parseFloat(tok);
  }

  /** parse_traceroute_output(), also returning per-line token spans for the visualiser. */
  function parseOutput(output) {
    const hops = [], lines = [];
    for (const line of output.split(/\r\n|\r|\n/)) {
      const m = HOP_LINE_RE.exec(line);
      if (!m) {
        lines.push({ line, hop: false });
        continue;
      }
      const hop = { hop_number: parseInt(m[1], 10), addresses: [], rtts_ms: [] };
      const restStart = line.length - m[2].length;
      const toks = [];
      for (const t of m[2].matchAll(TOKEN_RE)) {
        const g = t.groups;
        const span = { start: restStart + t.index, end: restStart + t.index + t[0].length };
        if (g.star) {
          hop.rtts_ms.push(null);
          toks.push({ ...span, kind: "star" });
        } else if (g.rtt) {
          hop.rtts_ms.push(parseRtt(g.rtt));
          toks.push({ ...span, kind: "rtt" });
        } else {
          const addr = g.ipv4 || g.ipv6;
          const valid = NP.isIP(addr);
          if (valid && !hop.addresses.includes(addr)) hop.addresses.push(addr);
          toks.push({ ...span, kind: valid ? (g.ipv4 ? "ipv4" : "ipv6") : "rej" });
        }
      }
      hops.push(hop);
      lines.push({ line, hop: true, numEnd: line.indexOf(m[1]) + m[1].length, numStart: line.indexOf(m[1]), toks });
    }
    return { hops, lines };
  }

  function parseDestination(output, target) {
    const m = HEADER_DEST_RE.exec(output);
    if (m && NP.isIP(m[1])) return m[1];
    return NP.isIP(target) ? target : null;
  }

  // Hop helpers mirror the Hop dataclass properties.
  const H = {
    ip: (h) => h.addresses[0] ?? null,
    responded: (h) => h.addresses.length > 0 && h.rtts_ms.some((r) => r !== null),
    valid: (h) => h.rtts_ms.filter((r) => r !== null),
    avg: (h) => (H.valid(h).length ? NP.round(NP.mean(H.valid(h)), 3) : null),
    min: (h) => (H.valid(h).length ? Math.min(...H.valid(h)) : null),
    max: (h) => (H.valid(h).length ? Math.max(...H.valid(h)) : null),
    toDict: (h) => ({ hop: h.hop_number, ip: H.ip(h), addresses: [...h.addresses], rtts_ms: [...h.rtts_ms], avg_rtt_ms: H.avg(h), min_rtt_ms: H.min(h), max_rtt_ms: H.max(h), responded: H.responded(h) }),
  };

  function assemble(target, command, output, error) {
    const res = { target, success: false, hops: [], destination_ip: null, reached_destination: false, error: error || null, command, raw_output: output };
    res.hops = parseOutput(output).hops;
    res.destination_ip = parseDestination(output, target);
    if (res.destination_ip) res.reached_destination = res.hops.some((h) => H.responded(h) && h.addresses.some((a) => NP.sameIP(a, res.destination_ip)));
    if (res.hops.length) res.success = true;
    else if (res.error === null) res.error = "Traceroute produced no hop information.";
    return res;
  }
  const toDict = (r) => ({ target: r.target, success: r.success, destination_ip: r.destination_ip, reached_destination: r.reached_destination, error: r.error, command: [...r.command], hops: r.hops.map(H.toDict) });

  const fmtMs = (v) => (v === null ? "*" : v >= 10 ? `${v.toFixed(0)} ms` : `${v.toFixed(1)} ms`);
  function formatResult(r) {
    if (!r.success) return `Traceroute failed: ${r.error}`;
    const L = [`${"Hop".padEnd(6)}${"Address".padEnd(42)}${"Avg RTT".padEnd(11)}Probes`];
    for (const h of r.hops) {
      let address = H.ip(h) || "*";
      if (h.addresses.length > 1) address += ` (+${h.addresses.length - 1} more)`;
      const resp = H.responded(h);
      L.push(`${String(h.hop_number).padEnd(6)}${address.padEnd(42)}${(resp ? fmtMs(H.avg(h)) : "*").padEnd(11)}${resp ? h.rtts_ms.map(fmtMs).join(" / ") : "no response"}`);
    }
    if (r.destination_ip) L.push("", `Destination ${r.destination_ip}: ${r.reached_destination ? "reached" : "NOT reached"}`);
    if (r.error) L.push(`Note: ${r.error}`);
    return L.join("\n");
  }

  // ================= simulated network =================
  const SCENARIOS = {
    clean: "Clean path: every router answers and the destination replies.",
    silent: "Two routers are configured not to send ICMP Time Exceeded, so they show as * * *. The trace still reaches the destination.",
    ocean: "The path crosses a submarine cable, so latency jumps by over 100 ms at one hop and stays high after it.",
    congested: "A congested peering link drops some probes and its RTTs vary a lot.",
    ratelimit: "One router deprioritises ICMP. It looks slow, but the hops after it are fast again, so the high RTT isn't a real slowdown on the path.",
    ecmp: "Load balancing (ECMP): different probes at the same TTL take different routers, so one hop lists several addresses.",
    firewall: "The destination's firewall drops probes. Every hop after the edge is * * * until max_hops, and the destination shows as NOT reached.",
    missing: "traceroute isn't installed: subprocess.run raises FileNotFoundError and the result carries an install hint.",
  };

  function simulatePath(target, scenario, queries, destIP) {
    const r = NP.rng(`path:${target}:${scenario}`);
    const ip = () => `${NP.randInt(r, 62, 213)}.${NP.randInt(r, 0, 255)}.${NP.randInt(r, 0, 255)}.${NP.randInt(r, 1, 254)}`;
    const nodes = [
      { ip: "192.168.1.1", lat: 0.6 + r() * 1.4, label: "home router" },
      { ip: `100.${NP.randInt(r, 64, 127)}.${NP.randInt(r, 0, 255)}.1`, lat: 6 + r() * 4, label: "ISP CGNAT" },
      { ip: `10.${NP.randInt(r, 0, 255)}.${NP.randInt(r, 0, 255)}.${NP.randInt(r, 1, 254)}`, lat: 0, label: "ISP aggregation" },
    ];
    const mid = NP.randInt(r, 4, 6);
    for (let i = 0; i < mid; i++) nodes.push({ ip: ip(), lat: 0, label: i < 2 ? "ISP backbone" : i === mid - 1 ? "destination network" : "transit / IX" });
    nodes.forEach((n, i) => i > 1 && (n.lat = nodes[i - 1].lat + 0.6 + r() * 3.2));
    if (scenario === "ocean") {
      const k = 5;
      for (let i = k; i < nodes.length; i++) nodes[i].lat += 118 + r() * 12;
      nodes[k].label = "submarine cable landing";
    }
    if (scenario === "silent") [3, 5].forEach((k) => (nodes[k].silent = true));
    if (scenario === "congested") Object.assign(nodes[4], { loss: 0.34, jitter: 14, lat: nodes[4].lat + 22, label: "congested peering" });
    if (scenario === "ratelimit") Object.assign(nodes[4], { lat: nodes[4].lat + 70 + r() * 15, jitterFixed: 6, label: "ICMP rate-limited" });
    if (scenario === "ecmp") nodes[4].alts = [ip(), ip()];
    const last = nodes[nodes.length - 1];
    nodes.push({ ip: destIP, lat: last.lat + 0.4 + r() * 1.5, label: "destination", dest: true, silent: scenario === "firewall" });

    return nodes.map((n, i) => ({
      ...n,
      probes: Array.from({ length: queries }, (_, q) => {
        if (n.silent || (n.loss && (q === 1 || r() < n.loss * 0.4))) return null;
        const jit = n.jitterFixed ?? n.jitter ?? 0.15 + n.lat * 0.03;
        return { ip: n.alts && q > 0 ? n.alts[(q - 1) % n.alts.length] : n.ip, rtt: Math.max(0.15, n.lat + Math.abs(NP.gauss(r)) * jit) };
      }),
    }));
  }

  function linuxLine(n, probes) {
    const parts = [];
    let lastIp = null;
    probes.forEach((p) => {
      if (!p) return parts.push("*");
      if (p.ip !== lastIp) parts.push(p.ip), (lastIp = p.ip);
      parts.push(`${p.rtt.toFixed(3)} ms`);
    });
    return `${String(n).padStart(2)}  ${parts.join("  ").replace(/\*  (?=\*)/g, "* ")}`;
  }
  function winLine(n, probes) {
    const cells = probes.slice(0, 3).map((p) => (p ? `${p.rtt < 1 ? "<1" : Math.round(p.rtt)} ms`.padStart(8) + " " : "     *   "));
    const resp = probes.filter(Boolean);
    return `${String(n).padStart(3)} ${cells.join("")} ${resp.length ? resp[resp.length - 1].ip : "Request timed out."}`;
  }
  function headerLines(os, target, dest, maxHops) {
    if (os === "windows")
      return NP.isIP(target) ? [`Tracing route to ${dest} over a maximum of ${maxHops} hops`, ""] : [`Tracing route to ${target} [${dest}]`, `over a maximum of ${maxHops} hops:`, ""];
    return [`traceroute to ${target} (${dest}), ${maxHops} hops max, 60 byte packets`];
  }

  // ================= TTL explainer =================
  function initTTL() {
    const names = ["You", "R1", "R2", "R3", "R4", "Dest"];
    const W = 760, Hh = 170, xs = names.map((_, i) => 50 + i * ((W - 100) / 5));
    const build = () => {
    let svg = `<svg class="chart" viewBox="0 0 ${W} ${Hh}" role="img" aria-label="TTL diagram"><defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L10,5L0,10z" fill="${NP.col.info}"/></marker><marker id="ahr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L10,5L0,10z" fill="${NP.col.ok}"/></marker></defs>`;
    svg += `<line x1="${xs[0]}" x2="${xs[5]}" y1="70" y2="70" stroke="${NP.col.chAxis}" stroke-width="2"/>`;
    svg += `<line id="ttl-go" x1="${xs[0]}" y1="70" x2="${xs[1]}" y2="70" stroke="${NP.col.info}" stroke-width="3" marker-end="url(#ah)"/>`;
    svg += `<path id="ttl-back" d="" fill="none" stroke="${NP.col.ok}" stroke-width="2" stroke-dasharray="6 5" marker-end="url(#ahr)"/>`;
    names.forEach((n, i) => {
      const isEnd = i === 0 || i === 5;
      svg += `<g id="ttl-n${i}"><${isEnd ? `circle cx="${xs[i]}" cy="70" r="18"` : `rect x="${xs[i] - 17}" y="53" width="34" height="34" rx="6"`} fill="${NP.col.chNode}" stroke="${NP.col.chAxis}" stroke-width="2"/><text x="${xs[i]}" y="74" fill="${NP.col.chLabel}" font-size="11" text-anchor="middle">${n}</text><text class="ttlv" x="${xs[i]}" y="38" fill="${NP.col.info}" font-size="11" text-anchor="middle"></text></g>`;
    });
    svg += `<text id="ttl-burst" x="0" y="0" font-size="20" text-anchor="middle" fill="${NP.col.bad}"></text><text id="ttl-backlbl" x="0" y="0" font-size="11" text-anchor="middle" fill="${NP.col.ok}"></text></svg>`;
    $("#ttl-svg").innerHTML = svg;
    };
    build();

    const set = (ttl) => {
      $("#ttl-o").textContent = ttl;
      const stop = Math.min(ttl, 5);
      const reached = ttl >= 5;
      $("#ttl-go").setAttribute("x2", xs[stop] - 20);
      names.forEach((_, i) => {
        const g = $(`#ttl-n${i}`);
        const shape = g.firstElementChild;
        shape.setAttribute("stroke", i === stop ? (reached ? NP.col.teal : NP.col.bad) : i < stop && i > 0 ? NP.col.info : NP.col.chAxis);
        g.querySelector(".ttlv").textContent = i > 0 && i <= stop ? `TTL ${ttl - i + 1}→${ttl - i}` : i === 0 ? `TTL=${ttl}` : "";
      });
      $("#ttl-back").setAttribute("d", `M${xs[stop]} 92 Q ${(xs[stop] + xs[0]) / 2} ${150} ${xs[0] + 14} 92`);
      const b = $("#ttl-backlbl");
      b.setAttribute("x", (xs[stop] + xs[0]) / 2);
      b.setAttribute("y", 136);
      b.textContent = reached ? "ICMP reply from the destination" : `ICMP Time Exceeded from R${stop}`;
      const burst = $("#ttl-burst");
      burst.setAttribute("x", xs[stop]);
      burst.setAttribute("y", 28 - 6);
      burst.textContent = reached ? "" : "✸";
      $("#ttl-explain").innerHTML = reached
        ? `With <b>TTL=${ttl}</b> the probe survives every router and reaches the destination, which replies. That reply is the <b>last hop</b> and tells traceroute it can stop.`
        : `The probe leaves with <b>TTL=${ttl}</b>. Each router subtracts 1, and <b>R${stop}</b> takes it to 0, drops the packet and sends back <b>ICMP Time Exceeded</b> from its own address. That reveals hop ${stop}'s IP, and the time it took is the hop's RTT.`;
    };
    const range = $("#ttl-range");
    range.addEventListener("input", () => set(+range.value));
    let timer = null;
    $("#ttl-play").addEventListener("click", () => {
      if (timer) return;
      let t = 1;
      set(t);
      range.value = t;
      timer = setInterval(() => {
        t++;
        if (t > 5) return clearInterval(timer), (timer = null);
        range.value = t;
        set(t);
      }, 1300);
    });
    set(1);
    NP.on("theme", () => (build(), set(+range.value)));
  }

  // ================= UI =================
  const ui = {};

  function opts() {
    return { os: ui.os.value, maxHops: +$("#tr-maxhops").value, timeout: +$("#tr-timeout").value, queries: ui.os.value === "windows" ? 3 : +$("#tr-queries").value };
  }

  function updateControls() {
    const o = opts();
    const v = validateTarget($("#tr-target").value);
    $("#tr-maxhops-o").textContent = o.maxHops;
    $("#tr-timeout-o").textContent = o.timeout + " s";
    $("#tr-queries-o").textContent = o.os === "windows" ? "3 (fixed)" : o.queries;
    $("#tr-queries").disabled = o.os === "windows";
    $("#tr-checks").innerHTML = v.checks.map((c) => `<li class="${c.ok === null ? "skip" : c.ok ? "ok" : "fail"}">${esc(c.label)}</li>`).join("") + (v.error ? `<li class="fail" style="color:var(--bad)">ValueError: ${esc(v.error)}</li>` : "");
    const cmd = buildCommand(v.target || "<target>", o.maxHops, o.timeout, o.queries, o.os);
    $("#tr-cmd").innerHTML = `<span class="p">$ </span>` + cmd.map((c, i) => (i === 0 ? esc(c) : c.startsWith("-") ? `<span class="flag">${esc(c)}</span>` : i === cmd.length - 1 ? `<span class="arg">${esc(c)}</span>` : esc(c))).join(" ");
    const per = o.os === "windows" ? 3 : o.queries;
    $("#tr-budget").innerHTML = `overall_timeout = ${o.maxHops} hops × ${per} probes × ${o.timeout} s + ${SUBPROCESS_GRACE_SECONDS} = <b>${NP.round(o.maxHops * per * o.timeout + SUBPROCESS_GRACE_SECONDS, 1)} s</b>`;
    $("#tr-scn-note").textContent = SCENARIOS[$("#tr-scenario").value];
  }

  function rungHTML(n, total) {
    return `<div class="rung" id="rung-${n}"><span class="ttl">TTL ${n}</span><div class="lane"><span class="router" style="left:${Math.min(97, 6 + (n / Math.max(total, 1)) * 91)}%"></span></div><div class="who"><small>probing…</small></div></div>`;
  }

  async function animateRung(el, n, total, probes, fast) {
    const lane = el.querySelector(".lane");
    const stopPct = Math.min(97, 6 + (n / Math.max(total, 1)) * 91);
    if (!fast) {
      await Promise.all(
        probes.map(
          (p, i) =>
            new Promise((res) => {
              const d = document.createElement("span");
              d.className = "dot";
              lane.appendChild(d);
              const w = lane.clientWidth;
              const to = (w * stopPct) / 100 - 4;
              const kf = p ? [{ transform: "translateX(0)" }, { transform: `translateX(${to}px)` }, { transform: "translateX(0)", background: NP.col.ok }] : [{ transform: "translateX(0)", opacity: 1 }, { transform: `translateX(${to}px)`, opacity: 0.1 }];
              const a = d.animate(kf, { duration: p ? 420 : 700, delay: i * 90, easing: "ease-in-out" });
              const finish = () => (d.remove(), res());
              a.onfinish = finish;
              setTimeout(finish, 1200 + i * 90); // animations can stall in hidden tabs
            })
        )
      );
    }
  }

  async function run() {
    if (ui.busy) return null;
    ui.busy = true;
    ui.skip = false;
    $("#tr-run").disabled = true;
    $("#tr-skip").hidden = false;
    const op = opts();
    const scenario = $("#tr-scenario").value;
    const pill = $("#tr-status");
    const ladder = $("#tr-ladder");
    const term = NP.term($("#tr-raw"));
    term.clear();
    ui.tabs.selectTab("raw");
    ladder.innerHTML = "";
    const v = validateTarget($("#tr-target").value);
    let result;
    const done = (res) => {
      ui.last = res;
      render(res);
      $("#tr-run").disabled = false;
      $("#tr-skip").hidden = true;
      ui.busy = false;
      return res;
    };

    if (v.error) {
      // run_traceroute catches the ValueError and returns it in the result.
      term.append(`<span class="c-bad"># validate_target() raised ValueError — no process was started</span>`);
      ladder.innerHTML = `<div class="empty">${esc(v.error)}</div>`;
      pill.className = "status-pill bad";
      pill.textContent = "invalid target";
      return done({ target: String($("#tr-target").value), success: false, hops: [], destination_ip: null, reached_destination: false, error: v.error, command: [], raw_output: "" });
    }
    const command = buildCommand(v.target, op.maxHops, op.timeout, op.queries, op.os);
    term.append(`<span class="prompt">$ ${esc(command.join(" "))}</span>`);

    if (scenario === "missing") {
      const tool = command[0];
      const hint = tool === "traceroute" ? "Install it with 'sudo apt install traceroute' (Debian/Ubuntu) or 'sudo dnf install traceroute' (Fedora)." : "";
      term.append(`<span class="c-bad">FileNotFoundError: [Errno 2] No such file or directory: '${tool}'</span>`);
      ladder.innerHTML = `<div class="empty">'${esc(tool)}' command not found.</div>`;
      pill.className = "status-pill bad";
      pill.textContent = "tool missing";
      return done({ target: v.target, success: false, hops: [], destination_ip: null, reached_destination: false, error: `'${tool}' command not found. ${hint}`.trim(), command, raw_output: "" });
    }

    pill.className = "status-pill run";
    pill.textContent = "tracing…";
    const dest = NP.simIP(v.target);
    const nodes = simulatePath(v.target, scenario, op.queries, dest);
    const lines = headerLines(op.os, v.target, dest, op.maxHops);
    lines.forEach((l) => term.append(esc(l)));
    const total = Math.min(op.maxHops, scenario === "firewall" ? op.maxHops : nodes.length);
    for (let n = 1; n <= total; n++) {
      const node = nodes[n - 1] || { silent: true, probes: Array(op.queries).fill(null), label: "no reply" };
      ladder.insertAdjacentHTML("beforeend", rungHTML(n, Math.min(total, 16)));
      const el = $(`#rung-${n}`);
      ladder.scrollTop = ladder.scrollHeight;
      await animateRung(el, n, Math.min(total, 16), node.probes, ui.skip || NP.reducedMotion);
      const resp = node.probes.filter(Boolean);
      el.classList.add(resp.length ? "resp" : "silent");
      if (node.dest && resp.length) el.classList.add("dest");
      el.querySelector(".who").innerHTML = resp.length
        ? `${esc(resp[0].ip)}${node.alts ? ` <span class="tag warn">+${new Set(resp.map((p) => p.ip)).size - 1}</span>` : ""}<small>${esc(node.label)} · ${NP.round(NP.mean(resp.map((p) => p.rtt)), 1)} ms</small>`
        : `* * *<small>${esc(node.label || "silent")}</small>`;
      const line = op.os === "windows" ? winLine(n, node.probes) : linuxLine(n, node.probes);
      lines.push(line);
      term.append(esc(line), resp.length ? "" : "c-dim");
      if (node.dest && resp.length) break;
    }
    if (op.os === "windows") {
      lines.push("", "Trace complete.");
      term.append("\nTrace complete.");
    }
    result = assemble(v.target, command, lines.join("\n"), null);
    pill.className = "status-pill " + (result.reached_destination ? "ok" : "bad");
    pill.textContent = result.reached_destination ? `reached in ${result.hops.length} hops` : "destination NOT reached";
    return done(result);
  }

  function render(r) {
    $("#tr-format").textContent = formatResult(r);
    $("#tr-json").innerHTML = NP.hlPy(NP.pyJson(toDict(r), { floats: ["rtts_ms", "avg_rtt_ms", "min_rtt_ms", "max_rtt_ms"] }));
    const resp = r.hops.filter(H.responded);
    const s = (k, v, cls = "") => `<div class="stat ${cls}"><div class="k">${k}</div><div class="v">${v}</div></div>`;
    $("#tr-stats").innerHTML = r.success
      ? s("Hops parsed", r.hops.length) + s("Responding", resp.length) + s("Silent (* * *)", r.hops.length - resp.length, r.hops.length - resp.length ? "warn" : "") + s("Destination", esc(r.destination_ip || "unknown")) + s("Reached", r.reached_destination ? "yes" : "no", r.reached_destination ? "ok" : "bad")
      : s("success", "False", "bad") + s("error", `<small>${esc(r.error)}</small>`);
    $("#tr-to-analysis").disabled = !r.success;
    if (r.raw_output) {
      $("#pg-input").value = r.raw_output;
      playground();
    }
  }

  // ================= parser playground =================
  const SAMPLES = {
    linux: ` traceroute to example.com (93.184.215.14), 30 hops max, 60 byte packets
 1  192.168.1.1  0.912 ms  0.874 ms  0.861 ms
 2  100.72.0.1  7.402 ms  7.388 ms  7.951 ms
 3  * * *
 4  72.14.215.85  12.113 ms 72.14.236.69  12.402 ms  11.987 ms
 5  10.252.1.9  13.020 ms *  13.444 ms
 6  93.184.215.14  13.101 ms  13.090 ms  13.122 ms`,
    windows: `
Tracing route to example.com [93.184.215.14]
over a maximum of 30 hops:

  1    <1 ms    <1 ms    <1 ms  192.168.1.1
  2     7 ms     7 ms     8 ms  100.72.0.1
  3     *        *        *     Request timed out.
  4    12 ms    12 ms    11 ms  72.14.215.85
  5    13 ms     *       13 ms  10.252.1.9
  6    13 ms    13 ms    13 ms  93.184.215.14

Trace complete.`,
    tricky: `traceroute6 to ipv6.google.com (2404:6800:4009:81f::200e), 30 hops max, 80 byte packets
 1  fe80::1  1.204 ms  1.101 ms  1.087 ms
 2  2001:db8:10::1  9.877 ms  9.812 ms  9.990 ms
 3  999.1.2.3  10.1 ms !H  10.4 ms !H  *
 4  2404:6800:4009:81f::200e  14.020 ms  14.007 ms  13.950 ms
Note: lines that don't start with a number are ignored
42 any line that starts with a number is treated as a hop, even this one`,
  };

  function playground() {
    const text = $("#pg-input").value;
    const { hops, lines } = parseOutput(text);
    let html = "";
    for (const L of lines) {
      if (!L.hop) {
        html += `<span class="ln-skip">${esc(L.line) || " "}</span>\n`;
        continue;
      }
      let s = "", pos = 0;
      const spans = [{ start: L.numStart, end: L.numEnd, kind: "hopnum" }, ...L.toks].sort((a, b) => a.start - b.start);
      for (const t of spans) {
        s += esc(L.line.slice(pos, t.start)) + `<span class="tok-${t.kind}">${esc(L.line.slice(t.start, t.end))}</span>`;
        pos = t.end;
      }
      html += s + esc(L.line.slice(pos)) + "\n";
    }
    $("#pg-view").innerHTML = html;
    const dest = parseDestination(text, "");
    $("#pg-dest").innerHTML = `_HEADER_DEST_RE → destination_ip = <code>${esc(dest ?? "None")}</code> · reached_destination = <code>${dest ? (hops.some((h) => H.responded(h) && h.addresses.some((a) => NP.sameIP(a, dest))) ? "True" : "False") : "False"}</code>`;
    $("#pg-hops").innerHTML = hops.length
      ? hops.map((h) => `<tr class="${H.responded(h) ? "" : "silent"}"><td>${h.hop_number}</td><td>${h.addresses.length ? h.addresses.map(esc).join("<br>") : "[]"}</td><td>[${h.rtts_ms.map((x) => (x === null ? "None" : NP.pyFloat(x))).join(", ")}]</td><td class="num">${H.avg(h) === null ? "None" : NP.pyFloat(H.avg(h))}</td><td>${H.responded(h) ? '<span class="tag ok">True</span>' : '<span class="tag dim">False</span>'}</td></tr>`).join("")
      : `<tr><td colspan="5" style="color:var(--dim)">No hop lines found → []</td></tr>`;
  }

  function init() {
    initTTL();
    ui.os = NP.seg($("#tr-os"), updateControls);
    ui.tabs = $("#tr-tabs");
    ["#tr-target", "#tr-maxhops", "#tr-timeout", "#tr-queries", "#tr-scenario"].forEach((s) => $(s).addEventListener("input", updateControls));
    $("#tr-run").addEventListener("click", () => run());
    $("#tr-skip").addEventListener("click", () => (ui.skip = true));
    $("#tr-target").addEventListener("keydown", (e) => e.key === "Enter" && run());
    $$("#tr-target-chips .chip").forEach((c) => c.addEventListener("click", () => (($("#tr-target").value = c.dataset.v), updateControls())));
    $("#pg-input").addEventListener("input", playground);
    $$("#pg-samples .chip").forEach((c) => c.addEventListener("click", () => (($("#pg-input").value = SAMPLES[c.dataset.v]), playground())));
    $("#tr-to-analysis").addEventListener("click", () => ui.last && (location.href = NP.pageUrl("analysis.html", { path: JSON.stringify(fromResult(ui.last)) })));
    if (/win/i.test(navigator.platform || navigator.userAgent)) ui.os.set("windows");
    $("#pg-input").value = SAMPLES.linux;
    playground();
    const t = NP.params.get("target");
    if (t !== null) $("#tr-target").value = t;
    if (SCENARIOS[NP.params.get("scenario")]) $("#tr-scenario").value = NP.params.get("scenario");
    updateControls();
    if (t !== null && NP.params.has("run")) run();
  }

  // Headless run_traceroute() on the simulated network, for the overview pipeline.
  function simulate(target, scenario, os) {
    const v = validateTarget(target);
    if (v.error) return { result: { success: false, error: v.error }, path: null };
    const command = buildCommand(v.target, DEFAULT_MAX_HOPS, 2, 3, os);
    const dest = NP.simIP(v.target);
    const nodes = simulatePath(v.target, scenario, 3, dest);
    const lines = headerLines(os, v.target, dest, DEFAULT_MAX_HOPS);
    nodes.forEach((n, i) => lines.push(os === "windows" ? winLine(i + 1, n.probes) : linuxLine(i + 1, n.probes)));
    if (os === "windows") lines.push("", "Trace complete.");
    const result = assemble(v.target, command, lines.join("\n"), null);
    return { result, path: result.success ? fromResult(result) : null };
  }

  const fromResult = (r) => ({ target: r.target, reached: r.reached_destination, hops: r.hops.map((h) => ({ hop: h.hop_number, ip: H.ip(h), rtts: [...h.rtts_ms] })) });

  NP.trace = { init, simulate };
})();
