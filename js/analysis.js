/* Port of path_analysis/analyzer.py — analyze_hop(), analyze_path() and summary(), with an editable hop dataset. */
(function () {
  const { $, $$, esc } = NP;
  const ui = { target: "example.com", reached: true };

  // ---------------- ported logic ----------------
  function analyzeHop(hop, ip, rtts) {
    const got = rtts.filter((r) => r !== null);
    return {
      hop,
      ip,
      sent: rtts.length,
      received: got.length,
      min_rtt: got.length ? Math.min(...got) : null,
      avg_rtt: got.length ? NP.mean(got) : null,
      max_rtt: got.length ? Math.max(...got) : null,
      jitter: got.length > 1 ? NP.pstdev(got) : got.length ? 0.0 : null,
      loss_pct: rtts.length ? (100 * (rtts.length - got.length)) / rtts.length : 100.0,
      delta_ms: null,
    };
  }

  function analyzePath(hops, jumpMs = 50, lossThresh = 20) {
    const stats = hops.map((h) => analyzeHop(h.hop, h.ip, h.rtts));
    let prev = null;
    for (const s of stats) {
      if (s.avg_rtt !== null) {
        if (prev !== null) s.delta_ms = s.avg_rtt - prev;
        prev = s.avg_rtt;
      }
    }
    const isJump = (s) => s.delta_ms !== null && s.delta_ms > jumpMs;
    const isLoss = (s) => s.loss_pct > 0 && s.loss_pct < 100 && s.loss_pct >= lossThresh;
    const bottlenecks = stats.filter((s) => isJump(s) || isLoss(s));
    return { stats, bottlenecks, isJump, isLoss };
  }

  const f1 = (x) => x.toFixed(1);
  function summary(stats, bottlenecks, target, reached) {
    const L = [];
    if (target) L.push(`Path analysis for ${target}`);
    L.push(`${"Hop".padStart(3)}  ${"IP".padEnd(18)}${"Avg ms".padStart(9)}${"Jitter".padStart(9)}${"Loss %".padStart(8)}${"Delta".padStart(9)}`);
    for (const s of stats) {
      const ip = s.ip || "*";
      if (s.avg_rtt === null) L.push(`${String(s.hop).padStart(3)}  ${ip.padEnd(18)}${"-".padStart(9)}${"-".padStart(9)}${s.loss_pct.toFixed(0).padStart(8)}${"-".padStart(9)}`);
      else {
        const delta = s.delta_ms !== null ? (s.delta_ms >= 0 ? "+" : "") + f1(s.delta_ms) : "-";
        L.push(`${String(s.hop).padStart(3)}  ${ip.padEnd(18)}${f1(s.avg_rtt).padStart(9)}${f1(s.jitter).padStart(9)}${s.loss_pct.toFixed(0).padStart(8)}${delta.padStart(9)}`);
      }
    }
    const responding = stats.filter((s) => s.avg_rtt !== null);
    L.push("", `Total hops: ${stats.length} (${stats.filter((s) => s.avg_rtt === null).length} silent)`);
    if (responding.length) {
      L.push(`End-to-end RTT (last responding hop): ${f1(responding[responding.length - 1].avg_rtt)} ms`);
      const wd = responding.filter((s) => s.delta_ms !== null);
      if (wd.length) {
        const worst = wd.reduce((a, b) => (b.delta_ms > a.delta_ms ? b : a));
        L.push(`Biggest latency jump: hop ${worst.hop} (${worst.ip}) +${f1(worst.delta_ms)} ms`);
      }
    }
    if (reached !== null && reached !== undefined) L.push(`Destination reached: ${reached ? "yes" : "no"}`);
    L.push(bottlenecks.length ? "Possible bottlenecks: " + bottlenecks.map((b) => `hop ${b.hop}`).join(", ") : "No bottlenecks detected.");
    return L.join("\n");
  }

  // ---------------- presets ----------------
  const PRESETS = {
    clean: { target: "example.com", reached: true, text: `1  192.168.1.1     1.1 0.9 1.0\n2  100.72.0.1      7.4 7.3 7.9\n3  10.31.4.1       9.0 8.8 9.4\n4  72.14.215.85    12.1 12.4 11.9\n5  142.250.60.1    13.0 13.4 13.2\n6  93.184.215.14   13.1 13.0 13.2` },
    ocean: { target: "sydney.example.net", reached: true, text: `1  192.168.1.1     1.2 1.0 1.1\n2  100.64.8.1      6.8 7.0 6.9\n3  10.20.0.5       9.1 9.3 9.0\n4  80.81.192.12    14.2 14.0 14.6\n5  4.69.140.1      15.3 15.1 15.9\n6  202.84.143.17   152.4 151.8 153.0\n7  202.84.224.10   155.0 154.6 155.4\n8  203.0.113.80    156.2 156.0 156.9` },
    congested: { target: "files.example.org", reached: true, text: `1  192.168.1.1     1.0 1.1 0.9\n2  100.70.0.1      7.2 7.5 7.1\n3  10.8.0.1        9.4 9.8 9.1\n4  195.66.224.31   38.2 * 61.9\n5  62.115.120.4    31.0 30.4 32.2\n6  198.51.100.20   32.1 31.9 32.5` },
    silent: { target: "8.8.8.8", reached: true, text: `1  192.168.1.1     0.8 0.9 0.8\n2  *               * * *\n3  10.0.4.1        8.9 9.2 8.7\n4  *               * * *\n5  108.170.248.1   11.8 12.1 11.9\n6  8.8.8.8         12.3 12.2 12.4` },
    ratelimit: { target: "api.example.com", reached: true, text: `1  192.168.1.1     1.0 1.2 1.1\n2  100.66.0.1      6.9 7.1 7.0\n3  10.1.1.1        8.8 9.0 8.7\n4  154.54.30.1     84.5 91.2 79.3\n5  154.54.42.9     15.2 15.0 15.6\n6  198.51.100.9    15.9 16.1 15.8` },
    firewall: { target: "secure.example.com", reached: false, text: `1  192.168.1.1     1.0 1.1 1.0\n2  100.66.0.1      7.0 6.9 7.3\n3  10.1.1.1        9.0 8.9 9.2\n4  203.0.113.1     14.1 14.3 13.9\n5  *               * * *\n6  *               * * *\n7  *               * * *` },
  };

  // ---------------- input parsing (hop / ip / rtts per line) ----------------
  function parseText(text) {
    const hops = [], errors = [];
    text.split(/\n/).forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line.startsWith("#")) return;
      const p = line.split(/\s+/);
      const hop = parseInt(p[0], 10);
      if (!Number.isFinite(hop)) return errors.push(`line ${i + 1}: first column must be the hop number`);
      if (p.length < 3) return errors.push(`line ${i + 1}: need "hop ip rtt [rtt …]"`);
      const rtts = p.slice(2).map((t) => (t === "*" ? null : parseFloat(t)));
      if (rtts.some((r) => r !== null && !Number.isFinite(r))) return errors.push(`line ${i + 1}: RTTs must be numbers or *`);
      hops.push({ hop, ip: p[1] === "*" ? null : p[1], rtts });
    });
    return { hops, errors };
  }
  const toText = (hops) => hops.map((h) => `${String(h.hop).padEnd(3)}${(h.ip || "*").padEnd(18)}${h.rtts.map((r) => (r === null ? "*" : NP.round(r, 2))).join(" ")}`).join("\n");

  // ---------------- rendering ----------------
  function chart(stats, res, jump, loss) {
    const W = 760, top = 32, hLat = 200, gap = 34, hLoss = 70, H = top + hLat + gap + hLoss + 26, pl = 46, pr = 14;
    const n = stats.length;
    const maxV = Math.max(5, ...stats.map((s) => s.max_rtt ?? 0)) * 1.15;
    const x = (i) => pl + ((W - pl - pr) / Math.max(n, 1)) * (i + 0.5);
    const y = (v) => top + hLat * (1 - v / maxV);
    const yl = (p) => top + hLat + gap + hLoss * (1 - p / 100);
    let g = "";
    for (let k = 0; k <= 4; k++) {
      const v = (maxV / 4) * k;
      g += `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}" stroke="${NP.col.chGrid}"/><text x="${pl - 6}" y="${y(v) + 4}" fill="${NP.col.chText}" font-size="10" text-anchor="end">${Math.round(v)}</text>`;
    }
    g += `<text x="6" y="${top - 18}" fill="${NP.col.chMuted}" font-size="10">avg RTT (ms) · bar = min–max · Δ = latency added</text>`;
    g += `<text x="6" y="${top + hLat + gap - 8}" fill="${NP.col.chMuted}" font-size="10">loss %</text>`;
    g += `<line x1="${pl}" x2="${W - pr}" y1="${yl(0)}" y2="${yl(0)}" stroke="${NP.col.chAxis}"/><line x1="${pl}" x2="${W - pr}" y1="${yl(loss)}" y2="${yl(loss)}" stroke="${NP.col.bad}" stroke-dasharray="4 4" opacity=".7"/><text x="${W - pr}" y="${yl(loss) - 4}" fill="${NP.col.bad}" font-size="10" text-anchor="end">loss_thresh ${loss}%</text>`;
    // avg line through responding hops
    const pts = stats.map((s, i) => (s.avg_rtt !== null ? `${x(i)},${y(s.avg_rtt)}` : null)).filter(Boolean);
    if (pts.length > 1) g += `<polyline points="${pts.join(" ")}" fill="none" stroke="${NP.col.warn}" stroke-width="2" opacity=".55"/>`;
    stats.forEach((s, i) => {
      const flagged = res.bottlenecks.includes(s);
      const col = flagged ? NP.col.bad : NP.col.warn;
      const tip = `Hop ${s.hop} ${s.ip || "*"}\n` + (s.avg_rtt === null ? "silent (100% loss)" : `avg ${f1(s.avg_rtt)} ms · jitter ${f1(s.jitter)} · loss ${s.loss_pct.toFixed(0)}%` + (s.delta_ms !== null ? ` · Δ ${f1(s.delta_ms)} ms` : ""));
      g += `<g><title>${esc(tip)}</title>`;
      if (s.avg_rtt === null) {
        g += `<circle cx="${x(i)}" cy="${y(0) - 8}" r="6" fill="none" stroke="${NP.col.chText}" stroke-dasharray="2 2"/><text x="${x(i)}" y="${y(0) - 18}" fill="${NP.col.chText}" font-size="11" text-anchor="middle">*</text>`;
      } else {
        g += `<line x1="${x(i)}" x2="${x(i)}" y1="${y(s.min_rtt)}" y2="${y(s.max_rtt)}" stroke="${col}" stroke-width="6" stroke-linecap="round" opacity=".35"/>`;
        if (flagged) g += `<circle cx="${x(i)}" cy="${y(s.avg_rtt)}" r="11" fill="rgba(255,107,107,.15)" stroke="${NP.col.bad}"/>`;
        g += `<circle cx="${x(i)}" cy="${y(s.avg_rtt)}" r="5" fill="${col}"/>`;
        if (s.delta_ms !== null && Math.abs(s.delta_ms) >= Math.max(3, jump * 0.2)) {
          g += `<text x="${x(i)}" y="${y(s.max_rtt) - 10}" fill="${res.isJump(s) ? NP.col.bad : NP.col.chMuted}" font-size="10" text-anchor="middle">Δ${s.delta_ms >= 0 ? "+" : ""}${f1(s.delta_ms)}</text>`;
        }
      }
      const lp = s.loss_pct;
      if (lp > 0) g += `<rect x="${x(i) - 9}" y="${yl(lp)}" width="18" height="${yl(0) - yl(lp)}" rx="2" fill="${res.isLoss(s) ? NP.col.bad : lp >= 100 ? NP.col.chSilent : NP.col.warn}" opacity=".8"/>`;
      g += `<text x="${x(i)}" y="${H - 8}" fill="${flagged ? NP.col.bad : NP.col.chText}" font-size="10" text-anchor="middle">${s.hop}</text></g>`;
    });
    $("#an-chart").innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Per-hop latency and loss">${g}</svg>`;
  }

  function verdict(s, res, jump, loss) {
    const r = [];
    if (res.isJump(s)) r.push(`Δ ${f1(s.delta_ms)} &gt; jump_ms ${jump}`);
    if (res.isLoss(s)) r.push(`loss ${s.loss_pct.toFixed(0)}% ≥ ${loss}% (partial)`);
    if (r.length) return `<span class="reason bad">⚑ ${r.join(" and ")}</span>`;
    if (s.avg_rtt === null) return `<span class="reason">silent: 100% loss is ignored</span>`;
    if (s.delta_ms !== null && s.delta_ms < 0) return `<span class="reason">negative Δ: normal (rate limiting / asymmetric route)</span>`;
    if (s.delta_ms === null) return `<span class="reason">first responding hop: no Δ</span>`;
    return `<span class="reason">ok</span>`;
  }

  function update() {
    const jump = +$("#an-jump").value, loss = +$("#an-loss").value;
    $("#an-jump-o").textContent = jump + " ms";
    $("#an-loss-o").textContent = loss + " %";
    const { hops, errors } = parseText($("#an-input").value);
    $("#an-errors").textContent = errors.join(" · ");
    $("#an-call").innerHTML = `<span class="p">&gt;&gt;&gt; </span>stats, bottlenecks = analyze_path(hops, <span class="flag">jump_ms</span>=${jump}, <span class="flag">loss_thresh</span>=${loss})`;
    if (!hops.length) {
      $("#an-chart").innerHTML = `<div class="empty">Add at least one hop line.</div>`;
      $("#an-table").innerHTML = "";
      $("#an-summary").textContent = "";
      return;
    }
    const res = analyzePath(hops, jump, loss);
    chart(res.stats, res, jump, loss);
    const n = (v) => (v === null ? "None" : f1(v));
    $("#an-table").innerHTML = res.stats
      .map((s) => `<tr class="${res.bottlenecks.includes(s) ? "flag" : s.avg_rtt === null ? "silent" : ""}"><td>${s.hop}</td><td>${esc(s.ip || "*")}</td><td class="num">${s.received}/${s.sent}</td><td class="num">${n(s.min_rtt)}</td><td class="num">${n(s.avg_rtt)}</td><td class="num">${n(s.max_rtt)}</td><td class="num">${n(s.jitter)}</td><td class="num">${s.loss_pct.toFixed(0)}</td><td class="num">${s.delta_ms === null ? "None" : (s.delta_ms >= 0 ? "+" : "") + f1(s.delta_ms)}</td><td>${verdict(s, res, jump, loss)}</td></tr>`)
      .join("");
    const sum = summary(res.stats, res.bottlenecks, ui.target, ui.reached);
    $("#an-summary").innerHTML = esc(sum)
      .replace(/^(Possible bottlenecks:.*)$/m, '<span class="c-bad">$1</span>')
      .replace(/^(No bottlenecks detected\.)$/m, '<span class="c-ok">$1</span>')
      .replace(/^(Path analysis for .*)$/m, '<span class="c-warn">$1</span>');
    const resp = res.stats.filter((s) => s.avg_rtt !== null);
    const s = (k, v, cls = "") => `<div class="stat ${cls}"><div class="k">${k}</div><div class="v">${v}</div></div>`;
    $("#an-stats").innerHTML =
      s("Hops", res.stats.length) + s("Silent", res.stats.length - resp.length) +
      s("End-to-end", resp.length ? `${f1(resp[resp.length - 1].avg_rtt)}<small> ms</small>` : "—") +
      s("Bottlenecks", res.bottlenecks.length, res.bottlenecks.length ? "bad" : "ok");
    ui.lastSummary = { bottlenecks: res.bottlenecks.map((b) => b.hop), hops: res.stats.length };
  }

  function loadPreset(key) {
    const p = PRESETS[key];
    ui.target = p.target;
    ui.reached = p.reached;
    $("#an-input").value = p.text;
    $("#an-source").textContent = `preset · target ${p.target}`;
    update();
  }

  function init() {
    $("#an-preset").addEventListener("change", (e) => e.target.value !== "trace" && loadPreset(e.target.value));
    ["#an-jump", "#an-loss", "#an-input"].forEach((s) => $(s).addEventListener("input", update));
    $("#an-reset").addEventListener("click", () => {
      $("#an-jump").value = 50;
      $("#an-loss").value = 20;
      update();
    });
    loadPreset("ocean");
    NP.on("theme", update);
    const raw = NP.params.get("path");
    if (raw) {
      try {
        load(JSON.parse(raw));
      } catch (e) {
        $("#an-source").textContent = "couldn't read the path from the URL — showing a preset";
      }
    }
  }

  function load(path) {
    ui.target = path.target;
    ui.reached = path.reached;
    const opt = $('#an-preset option[value="trace"]');
    opt.disabled = false;
    $("#an-preset").value = "trace";
    $("#an-input").value = toText(path.hops);
    $("#an-source").textContent = `from traceroute · target ${path.target}`;
    update();
    return ui.lastSummary;
  }

  NP.analysis = {
    init,
    // Headless analyze_path() for the overview pipeline.
    analyze: (hops, jumpMs, lossThresh) => {
      const { stats, bottlenecks } = analyzePath(hops, jumpMs, lossThresh);
      return { stats, bottlenecks };
    },
  };
})();
