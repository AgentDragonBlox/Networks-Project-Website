/* Port of ping_rtt/ping.py — ping() parsing + statistics and display_results(), driven by a simulated network. */
(function () {
  const { $, esc } = NP;
  const PATTERN = /time[=<]\s*(\d+(?:\.\d+)?)\s*ms/gi; // r"time[=<]\s*(\d+(?:\.\d+)?)\s*ms", re.IGNORECASE

  const PRESETS = {
    lan: { target: "192.168.1.1", base: 1.5, jitter: 0.6, loss: 0, note: "A router on your own network answers in about a millisecond. On Windows anything under 1 ms prints as <code>time&lt;1ms</code>, which the <code>[=&lt;]</code> in the regex accepts." },
    cdn: { target: "google.com", base: 18, jitter: 3, loss: 0, note: "A nearby CDN edge: low latency and steady RTTs." },
    far: { target: "203.0.113.80", base: 215, jitter: 14, loss: 0, note: "A server on another continent. Most of the RTT here is the speed of light in fibre, so it can't be tuned away." },
    wifi: { target: "gmail.com", base: 35, jitter: 28, loss: 25, note: "Congested Wi-Fi: RTTs swing a lot (high jitter) and some echo requests never come back." },
    down: { target: "192.0.2.55", base: 0, jitter: 0, loss: 100, note: "Nothing answers. No line matches <code>time=</code>, so received = 0, loss = 100% and the min/avg/max fields are <code>None</code>." },
    unreach: { target: "10.20.30.40", base: 0, jitter: 0, loss: 100, unreach: true, note: "<b>Edge case:</b> a gateway answers with <i>Destination host unreachable</i>. Windows counts those as received (<code>Lost = 0</code>), but the module only counts lines containing <code>time=</code>, so it correctly reports 100% loss." },
    hang: { target: "198.51.100.7", base: 0, jitter: 0, loss: 100, hang: true, note: "<b>Edge case:</b> the ping process doesn't exit within <code>timeout=30</code>. <code>subprocess.TimeoutExpired</code> is caught and the function returns a 100%-loss dict with an <code>error</code> key." },
  };

  const ui = {};

  // ---------- simulated OS ping output ----------
  function linuxTime(v) {
    return v < 1 ? v.toFixed(3) : v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : v.toFixed(0);
  }
  function simulatePackets(cfg, count) {
    const pk = [];
    for (let i = 0; i < count; i++) {
      if (cfg.hang || cfg.unreach || Math.random() * 100 < cfg.loss) pk.push(null);
      else pk.push(Math.max(0.2, cfg.base + Math.abs(NP.gauss(Math.random)) * cfg.jitter * (Math.random() < 0.5 ? 1 : 0.6) - cfg.jitter * 0.3));
    }
    return pk;
  }
  function replyLine(os, ip, i, v, cfg) {
    if (os === "windows") {
      if (cfg.unreach) return `Reply from 10.20.30.1: Destination host unreachable.`;
      if (v === null) return "Request timed out.";
      return `Reply from ${ip}: bytes=32 ${v < 1 ? "time<1ms" : `time=${Math.round(v)}ms`} TTL=117`;
    }
    if (cfg.unreach) return `From 10.20.30.1 icmp_seq=${i + 1} Destination Host Unreachable`;
    if (v === null) return null; // Linux prints nothing for a lost reply
    return `64 bytes from ${ip}: icmp_seq=${i + 1} ttl=117 time=${linuxTime(v)} ms`;
  }
  function header(os, target, ip) {
    if (os === "windows") return NP.isIP(target) ? `Pinging ${ip} with 32 bytes of data:` : `Pinging ${target} [${ip}] with 32 bytes of data:`;
    return `PING ${target} (${ip}) 56(84) bytes of data.`;
  }
  function footer(os, target, ip, pk, cfg) {
    const shown = pk.map((v) => (v === null ? null : os === "windows" ? (v < 1 ? 1 : Math.round(v)) : Number(linuxTime(v))));
    const got = shown.filter((v) => v !== null);
    const n = pk.length;
    if (os === "windows") {
      const recv = cfg.unreach ? n : got.length;
      const L = ["", `Ping statistics for ${ip}:`, `    Packets: Sent = ${n}, Received = ${recv}, Lost = ${n - recv} (${Math.round(((n - recv) / n) * 100)}% loss),`];
      if (got.length) {
        L.push("Approximate round trip times in milli-seconds:", `    Minimum = ${Math.min(...got)}ms, Maximum = ${Math.max(...got)}ms, Average = ${Math.round(NP.mean(got))}ms`);
      }
      return L;
    }
    const L = ["", `--- ${target} ping statistics ---`, `${n} packets transmitted, ${got.length} received, ${cfg.unreach ? `+${n} errors, ` : ""}${Math.round(((n - got.length) / n) * 100)}% packet loss, time ${(n - 1) * 1000 + NP.randInt(Math.random, 2, 60)}ms`];
    if (got.length) L.push(`rtt min/avg/max/mdev = ${[Math.min(...got), NP.mean(got), Math.max(...got), NP.pstdev(got)].map((x) => x.toFixed(3)).join("/")} ms`);
    return L;
  }

  // ---------- the ported module ----------
  function command(os, target, count) {
    return os === "windows" ? ["ping", "-n", String(count), target] : ["ping", "-c", String(count), target];
  }
  function errorResult(target, count, msg) {
    return { target, sent: count, received: 0, packet_loss: 100.0, latency_ms: [], min_rtt: null, avg_rtt: null, max_rtt: null, error: msg };
  }
  function parse(target, count, output) {
    const latency = [...output.matchAll(PATTERN)].map((m) => parseFloat(m[1]));
    const received = latency.length;
    const loss = ((count - received) / count) * 100;
    const has = latency.length > 0;
    return {
      target,
      sent: count,
      received,
      packet_loss: NP.round(loss, 2),
      latency_ms: latency.map((v) => NP.round(v, 2)),
      min_rtt: has ? NP.round(Math.min(...latency), 2) : null,
      avg_rtt: has ? NP.round(NP.mean(latency), 2) : null,
      max_rtt: has ? NP.round(Math.max(...latency), 2) : null,
    };
  }
  function displayResults(r) {
    const W = 42;
    const row = (label, value) => "║" + ` ${String(label).padEnd(13)}: ${value}`.padEnd(W) + "║";
    const bar = (a, b) => a + "═".repeat(W) + b;
    const f = (v) => (v === null ? "N/A" : `${NP.pyFloat(v)} ms`);
    const L = [bar("╔", "╗"), "║" + NP.center("NETWORK PING DIAGNOSTICS", W) + "║", bar("╠", "╣"),
      row("Target", r.target), row("Packets Sent", r.sent), row("Packets Recv", r.received), row("Packet Loss", `${NP.pyFloat(r.packet_loss)}%`),
      bar("╠", "╣"), "║" + NP.center("LATENCY / RTT", W) + "║", bar("╠", "╣")];
    if (r.latency_ms.length) r.latency_ms.forEach((v, i) => L.push(row(`Request ${i + 1}`, `${NP.pyFloat(v)} ms`)));
    else L.push(row("Status", "No response received."));
    L.push(bar("╠", "╣"), "║" + NP.center("RTT STATISTICS", W) + "║", bar("╠", "╣"), row("Minimum RTT", f(r.min_rtt)), row("Average RTT", f(r.avg_rtt)), row("Maximum RTT", f(r.max_rtt)), bar("╚", "╝"));
    return L.join("\n");
  }

  // ---------- rendering ----------
  function highlightMatches(text) {
    let out = "", last = 0;
    for (const m of text.matchAll(PATTERN)) {
      out += esc(text.slice(last, m.index));
      const g = m[0].lastIndexOf(m[1]);
      out += `<mark>${esc(m[0].slice(0, g))}<b>${esc(m[1])}</b>${esc(m[0].slice(g + m[1].length))}</mark>`;
      last = m.index + m[0].length;
    }
    return out + esc(text.slice(last));
  }

  function renderStats(r) {
    const s = (k, v, cls = "") => `<div class="stat ${cls}"><div class="k">${k}</div><div class="v">${v}</div></div>`;
    const ms = (v) => (v === null ? "N/A" : `${NP.pyFloat(v)}<small> ms</small>`);
    $("#ping-stats").innerHTML =
      s("Sent", r.sent) + s("Received", r.received, r.received === r.sent ? "ok" : "") +
      s("Packet loss", `${NP.pyFloat(r.packet_loss)}<small>%</small>`, r.packet_loss === 0 ? "ok" : r.packet_loss >= 100 ? "bad" : "warn") +
      s("Min RTT", ms(r.min_rtt)) + s("Avg RTT", ms(r.avg_rtt)) + s("Max RTT", ms(r.max_rtt));
  }

  function renderChart(pk, r) {
    const W = 640, H = 190, pl = 44, pr = 12, pt = 16, pb = 30;
    const vals = r.latency_ms;
    const maxV = Math.max(1, ...vals) * 1.2;
    const y = (v) => pt + (H - pt - pb) * (1 - v / maxV);
    const n = pk.length, bw = Math.min(46, ((W - pl - pr) / n) * 0.6);
    const x = (i) => pl + ((W - pl - pr) / n) * (i + 0.5);
    let g = "";
    for (let k = 0; k <= 4; k++) {
      const v = (maxV / 4) * k;
      g += `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}" stroke="${NP.col.chGrid}"/><text x="${pl - 6}" y="${y(v) + 4}" fill="${NP.col.chText}" font-size="10" text-anchor="end">${v < 10 ? v.toFixed(1) : Math.round(v)}</text>`;
    }
    let vi = 0;
    pk.forEach((p, i) => {
      g += `<text x="${x(i)}" y="${H - 10}" fill="${NP.col.chText}" font-size="10" text-anchor="middle">#${i + 1}</text>`;
      if (p === null) {
        g += `<text x="${x(i)}" y="${y(0) - 8}" fill="${NP.col.bad}" font-size="14" text-anchor="middle">✕</text><title>Request ${i + 1}: lost</title>`;
      } else {
        const v = vals[vi++];
        if (v === undefined) return;
        g += `<rect x="${x(i) - bw / 2}" y="${y(v)}" width="${bw}" height="${y(0) - y(v)}" rx="3" fill="rgba(69,214,196,.25)" stroke="${NP.col.teal}"><title>Request ${i + 1}: ${v} ms</title></rect><text x="${x(i)}" y="${y(v) - 5}" fill="${NP.col.chLabel}" font-size="10" text-anchor="middle">${v}</text>`;
      }
    });
    if (r.avg_rtt !== null) {
      g += `<line x1="${pl}" x2="${W - pr}" y1="${y(r.avg_rtt)}" y2="${y(r.avg_rtt)}" stroke="${NP.col.warn}" stroke-dasharray="4 4"/><line x1="${W - pr - 118}" x2="${W - pr - 96}" y1="${pt - 7}" y2="${pt - 7}" stroke="${NP.col.warn}" stroke-dasharray="4 4"/><text x="${W - pr}" y="${pt - 4}" fill="${NP.col.warn}" font-size="10" text-anchor="end">avg ${r.avg_rtt} ms</text>`;
    }
    g += `<text x="10" y="${pt - 4}" fill="${NP.col.chText}" font-size="10">ms</text>`;
    $("#ping-chart").innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="RTT per request">${g}</svg>`;
  }

  function animatePacket(track, v, i, lostAt) {
    return new Promise((done) => {
      const dot = document.createElement("div");
      let settled = false;
      const resolve = () => {
        if (settled) return;
        settled = true;
        dot.remove();
        done();
      };
      setTimeout(resolve, 2600); // animations can stall in hidden tabs
      dot.className = "pkt";
      dot.innerHTML = `<span>#${i + 1}</span>`;
      track.appendChild(dot);
      const w = track.clientWidth - 14;
      if (NP.reducedMotion) {
        dot.remove();
        return resolve();
      }
      const oneWay = 260 + Math.min(v ?? 300, 400) * 1.4;
      if (v === null) {
        const a = dot.animate([{ transform: "translateX(0)" }, { transform: `translateX(${w * lostAt}px)` }], { duration: oneWay * lostAt * 1.4, easing: "linear", fill: "forwards" });
        a.onfinish = () => {
          dot.classList.add("lost");
          dot.innerHTML = "<span>lost</span>";
          dot.animate([{ opacity: 1, transform: `translateX(${w * lostAt}px) scale(1)` }, { opacity: 0, transform: `translateX(${w * lostAt}px) scale(2)` }], { duration: 500, fill: "forwards" }).onfinish = () => {
            dot.remove();
            resolve();
          };
        };
      } else {
        const a = dot.animate([{ transform: "translateX(0)" }, { transform: `translateX(${w}px)` }], { duration: oneWay, easing: "ease-in-out", fill: "forwards" });
        a.onfinish = () => {
          dot.classList.add("back");
          dot.innerHTML = `<span>${NP.round(v, 1)} ms</span>`;
          dot.animate([{ transform: `translateX(${w}px)` }, { transform: "translateX(0)" }], { duration: oneWay, easing: "ease-in-out", fill: "forwards" }).onfinish = () => {
            dot.remove();
            resolve();
          };
        };
      }
    });
  }

  function cfg() {
    return { base: +$("#ping-base").value, jitter: +$("#ping-jitter").value, loss: +$("#ping-loss").value, ...(ui.special || {}) };
  }

  function updateCommand() {
    const cmd = command(ui.os.value, $("#ping-target").value.trim() || "<target>", +$("#ping-count").value);
    $("#ping-cmd").innerHTML = `<span class="p">$ </span>${esc(cmd[0])} <span class="flag">${cmd[1]}</span> ${cmd[2]} <span class="arg">${esc(cmd[3])}</span>`;
    $("#ping-count-o").textContent = $("#ping-count").value;
    $("#ping-base-o").textContent = $("#ping-base").value + " ms";
    $("#ping-jitter-o").textContent = $("#ping-jitter").value + " ms";
    $("#ping-loss-o").textContent = $("#ping-loss").value + " %";
  }

  function applyPreset(key) {
    const p = PRESETS[key];
    $("#ping-target").value = p.target;
    $("#ping-base").value = p.base;
    $("#ping-jitter").value = p.jitter;
    $("#ping-loss").value = p.loss;
    ui.special = p.hang ? { hang: true } : p.unreach ? { unreach: true } : null;
    ["#ping-base", "#ping-jitter", "#ping-loss"].forEach((s) => ($(s).disabled = !!ui.special));
    $("#ping-note").innerHTML = p.note;
    updateCommand();
  }

  async function run() {
    if (ui.busy) return null;
    ui.busy = true;
    $("#ping-run").disabled = true;
    const os = ui.os.value;
    const target = $("#ping-target").value.trim();
    const count = +$("#ping-count").value;
    const pill = $("#ping-status");
    if (!target) {
      pill.className = "status-pill bad";
      pill.textContent = "empty target";
      $("#ping-raw").innerHTML = `<span class="c-bad">Please enter a valid hostname or IP address.</span>\n<span class="c-dim"># The __main__ block refuses empty input before ping() is called.</span>`;
      $("#ping-run").disabled = false;
      ui.busy = false;
      return null;
    }
    const c = cfg();
    const ip = NP.simIP(target);
    $("#ping-dst-label").textContent = target;
    pill.className = "status-pill run";
    pill.textContent = "pinging…";
    const term = NP.term($("#ping-raw"));
    term.clear();
    ui.tabs.selectTab("raw");
    term.append(`<span class="prompt">$ ${esc(command(os, target, count).join(" "))}</span>`);
    const track = $("#ping-wire .track");
    const pk = simulatePackets(c, count);
    let result, raw;

    if (c.hang) {
      for (let i = 0; i < Math.min(count, 3); i++) await animatePacket(track, null, i, 0.85);
      term.append(`<span class="c-warn"># …no output. subprocess.run(…, timeout=30) raised TimeoutExpired</span>`);
      raw = "";
      result = errorResult(target, count, "Ping timed out");
    } else {
      const lines = [header(os, target, ip)];
      term.append(esc(lines[0]));
      const fast = NP.reducedMotion;
      for (let i = 0; i < count; i++) {
        const anim = animatePacket(track, pk[i], i, 0.6);
        if (!fast) await anim;
        const l = replyLine(os, ip, i, pk[i], c);
        if (l !== null) {
          lines.push(l);
          term.append(esc(l), pk[i] === null ? "c-dim" : "");
        }
        if (!fast) await NP.sleep(120);
      }
      footer(os, target, ip, pk, c).forEach((l) => (lines.push(l), term.append(esc(l), "c-dim")));
      raw = lines.join("\n");
      await NP.sleep(250);
      result = parse(target, count, raw);
      // swap the streamed text for the regex-highlighted version
      $("#ping-raw").innerHTML = `<span class="prompt">$ ${esc(command(os, target, count).join(" "))}</span>\n` + highlightMatches(raw);
    }

    $("#ping-matches").textContent = c.hang ? "No output to parse." : `${result.received} match(es) for time[=<]\\s*(\\d+(?:\\.\\d+)?)\\s*ms → received = ${result.received}, packet_loss = (${count} − ${result.received}) / ${count} × 100 = ${NP.pyFloat(result.packet_loss)}%`;
    renderStats(result);
    ui.lastChart = [pk.map((v) => (c.hang ? null : v)), result];
    renderChart(...ui.lastChart);
    const errLine = "error" in result ? `\nError: ${esc(result.error)}\n` : "";
    $("#ping-box").innerHTML = errLine + esc(displayResults(result));
    $("#ping-dict").innerHTML = NP.hlPy(NP.pyRepr(result, { floats: ["packet_loss", "latency_ms", "min_rtt", "avg_rtt", "max_rtt"] }));
    pill.className = "status-pill " + (result.received ? (result.packet_loss > 0 ? "run" : "ok") : "bad");
    pill.textContent = result.received ? `${result.received}/${count} replies · avg ${result.avg_rtt} ms` : "no replies";
    $("#ping-run").disabled = false;
    ui.busy = false;
    return result;
  }

  function init() {
    ui.os = NP.seg($("#ping-os"), updateCommand);
    ui.tabs = $("#ping-tabs");
    ["#ping-target", "#ping-count", "#ping-base", "#ping-jitter", "#ping-loss"].forEach((s) => $(s).addEventListener("input", updateCommand));
    $("#ping-preset").addEventListener("change", (e) => applyPreset(e.target.value));
    $("#ping-run").addEventListener("click", () => run());
    $("#ping-target").addEventListener("keydown", (e) => e.key === "Enter" && run());
    if (/win/i.test(navigator.platform || navigator.userAgent)) ui.os.set("windows");
    applyPreset("cdn");
    NP.on("theme", () => ui.lastChart && renderChart(...ui.lastChart));
    const t = NP.params.get("target");
    if (t !== null) {
      $("#ping-target").value = t;
      updateCommand();
      if (NP.params.has("run")) run();
    }
  }

  // Headless ping() against the "Nearby CDN" network, for the overview pipeline.
  function simulate(target, os, count = 4) {
    const c = { ...PRESETS.cdn };
    const ip = NP.simIP(target);
    const pk = simulatePackets(c, count);
    const lines = [header(os, target, ip)];
    pk.forEach((v, i) => {
      const l = replyLine(os, ip, i, v, c);
      if (l !== null) lines.push(l);
    });
    lines.push(...footer(os, target, ip, pk, c));
    return parse(target, count, lines.join("\n"));
  }

  NP.ping = { init, simulate };
})();
