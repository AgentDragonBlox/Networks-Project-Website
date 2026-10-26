/* Port of dns/dns_lookup.py — resolve(), _collect(), _result(), describe_record_used() and the CLI printout. */
(function () {
  const { $, $$, esc } = NP;
  const TYPE_ORDER = ["CNAME", "A", "AAAA", "MX", "PTR"];
  const TYPE_NUM = { 1: "A", 5: "CNAME", 12: "PTR", 15: "MX", 28: "AAAA" };

  // ---------------- simulated authoritative data (used in "Simulated" mode / offline fallback) ----------------
  const ZONE = {
    "example.com": { ttl: 3600, A: ["93.184.215.14"], AAAA: ["2606:2800:21f:cb07:6820:80da:af6b:8b2c"] },
    "www.github.com": { ttl: 3600, CNAME: "github.com" },
    "github.com": { ttl: 60, A: ["140.82.121.4"], MX: ["1 aspmx.l.google.com", "5 alt1.aspmx.l.google.com", "10 alt3.aspmx.l.google.com"] },
    "gmail.com": { ttl: 300, A: ["142.250.183.5"], AAAA: ["2404:6800:4009:82b::2005"], MX: ["5 gmail-smtp-in.l.google.com", "10 alt1.gmail-smtp-in.l.google.com", "20 alt2.gmail-smtp-in.l.google.com"] },
    "google.com": { ttl: 300, A: ["142.250.183.14"], AAAA: ["2404:6800:4009:830::200e"], MX: ["10 smtp.google.com"] },
    "www.wikipedia.org": { ttl: 600, CNAME: "dyna.wikimedia.org" },
    "dyna.wikimedia.org": { ttl: 600, A: ["103.102.166.224"], AAAA: ["2001:df2:e500:ed1a::1"] },
    "ipv6.google.com": { ttl: 21600, CNAME: "ipv6.l.google.com" },
    "ipv6.l.google.com": { ttl: 300, AAAA: ["2404:6800:4009:81f::200e"] },
    "mail-only.example.org": { ttl: 900, MX: ["10 mx.example.org"] },
  };
  const PTR = { "8.8.8.8": "dns.google", "1.1.1.1": "one.one.one.one", "140.82.121.4": "lb-140-82-121-4-fra.github.com", "2001:4860:4860::8888": "dns.google" };
  const NX_SUFFIX = /(\.invalid|\.test|\.localdomain|\.nope)$|does-not-exist|nonexistent/i;

  NP.knownHosts = {};
  Object.entries(ZONE).forEach(([n, z]) => z.A && (NP.knownHosts[n] = z.A[0]));
  NP.knownHosts["www.github.com"] = "140.82.121.4";
  NP.knownHosts["www.wikipedia.org"] = "103.102.166.224";

  function simZone(name) {
    if (ZONE[name]) return ZONE[name];
    if (NX_SUFFIX.test(name) || !name.includes(".")) return null;
    const r = NP.rng("zone:" + name);
    const z = { ttl: [60, 300, 600, 3600][NP.randInt(r, 0, 3)], A: [NP.simIP(name)] };
    if (r() > 0.4) z.AAAA = [`2606:4700:${NP.randInt(r, 0, 0xffff).toString(16)}::${NP.randInt(r, 1, 0xffff).toString(16)}`];
    if (r() > 0.5) z.MX = [`10 mail.${name.replace(/^www\./, "")}`];
    return z;
  }

  async function simQuery(qname, qtype) {
    await NP.sleep(120 + Math.random() * 160);
    let name = qname.toLowerCase().replace(/\.$/, "");
    if (qtype === "PTR") {
      const ip = reverseToIP(name);
      return PTR[ip] ? { status: "NOERROR", answer: [{ type: "PTR", name, value: PTR[ip], ttl: 86400 }] } : { status: "NXDOMAIN", answer: [] };
    }
    const answer = [];
    for (let i = 0; i < 8; i++) {
      const z = simZone(name);
      if (!z) return answer.length ? { status: "NOERROR", answer } : { status: "NXDOMAIN", answer };
      if (z.CNAME) {
        answer.push({ type: "CNAME", name, value: z.CNAME, ttl: z.ttl });
        name = z.CNAME;
        continue;
      }
      (z[qtype] || []).forEach((v) => answer.push({ type: qtype, name, value: v, ttl: z.ttl }));
      return { status: "NOERROR", answer };
    }
    return { status: "SERVFAIL", answer: [] };
  }

  // ---------------- live lookups over DNS-over-HTTPS (Cloudflare JSON API) ----------------
  function liveValue(type, data) {
    if (type === "CNAME" || type === "PTR") return data.replace(/\.$/, "");
    if (type === "MX") {
      const [pref, host = ""] = data.split(/\s+/);
      return `${pref} ${host.replace(/\.$/, "")}`;
    }
    return data;
  }
  async function liveQuery(qname, qtype) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000); // res.lifetime = 5.0
    try {
      const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(qname)}&type=${qtype}`;
      const r = await fetch(url, { headers: { accept: "application/dns-json" }, signal: ctrl.signal });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      const status = { 0: "NOERROR", 2: "SERVFAIL", 3: "NXDOMAIN", 5: "SERVFAIL" }[j.Status] || "SERVFAIL";
      const answer = (j.Answer || [])
        .filter((a) => TYPE_NUM[a.type])
        .map((a) => ({ type: TYPE_NUM[a.type], name: a.name.replace(/\.$/, ""), value: liveValue(TYPE_NUM[a.type], a.data), ttl: a.TTL }));
      return { status, answer };
    } catch (e) {
      if (e.name === "AbortError") return { status: "TIMEOUT", answer: [] };
      throw e; // network/CORS failure -> caller falls back to simulation
    } finally {
      clearTimeout(timer);
    }
  }

  // dns.reversename.from_address()
  function reverseName(ip) {
    if (NP.ipVersion(ip) === 4) return ip.split(".").reverse().join(".") + ".in-addr.arpa";
    const full = expandV6(ip).replace(/:/g, "");
    return full.split("").reverse().join(".") + ".ip6.arpa";
  }
  function expandV6(ip) {
    const n = NP.normIP(ip);
    const [head, tail = ""] = n.split("::");
    const h = head ? head.split(":") : [];
    const t = n.includes("::") && tail ? tail.split(":") : [];
    const fill = n.includes("::") ? Array(8 - h.length - t.length).fill("0") : [];
    return [...h, ...fill, ...t].map((x) => x.padStart(4, "0")).join(":");
  }
  function reverseToIP(rev) {
    if (rev.endsWith(".in-addr.arpa")) return rev.replace(".in-addr.arpa", "").split(".").reverse().join(".");
    const nib = rev.replace(".ip6.arpa", "").split(".").reverse().join("");
    return NP.normIP(nib.match(/.{4}/g).join(":"));
  }

  // ---------------- the ported module ----------------
  function recordUsed(records, ip) {
    if (records.some((r) => r.type === "CNAME")) return "CNAME";
    if (records.some((r) => r.type === "A" || r.type === "AAAA")) return NP.ipVersion(ip) === 4 ? "A" : "AAAA";
    if (records.some((r) => r.type === "PTR")) return "PTR";
    return null;
  }
  function makeResult(target, { ip = null, hostname = null, records = [], error = null } = {}) {
    const success = error === null && ip !== null;
    return {
      target,
      ip: success ? ip : null,
      ip_version: success ? NP.ipVersion(ip) : null,
      hostname,
      records,
      record_used: success ? recordUsed(records, ip) : null,
      cname_chain: records.filter((r) => r.type === "CNAME").map((r) => [r.name, r.value]),
      ipv4: records.filter((r) => r.type === "A").map((r) => r.value),
      ipv6: records.filter((r) => r.type === "AAAA").map((r) => r.value),
      success,
      status: success ? "SUCCESS" : "FAILED",
      error,
    };
  }
  function collect(answer, records) {
    let added = 0, dup = 0;
    for (const rec of answer) {
      if (!records.some((r) => r.type === rec.type && r.name === rec.name && r.value === rec.value)) {
        records.push(rec);
        added++;
      } else dup++;
    }
    return { added, dup };
  }

  /** resolve(target) with a step-by-step trace of what the Python code does. */
  async function resolve(rawTarget, mode, onStep) {
    const flow = {};
    const step = async (s) => {
      onStep(s, flow);
      await NP.sleep(160);
    };
    const query = async (name, qtype) => {
      if (mode === "live") {
        try {
          return await liveQuery(name, qtype);
        } catch (e) {
          mode = "sim";
          await step({ s: "skip", t: "Live DNS-over-HTTPS unreachable — switching to simulated resolver", d: String(e.message || e) });
        }
      }
      return simQuery(name, qtype);
    };

    if (rawTarget === null) return { r: makeResult(rawTarget, { error: "No input given." }), flow };
    const target = rawTarget.trim();
    flow.validate = true;
    await step({ s: "info", t: `<code>target.strip()</code> → <code>${esc(JSON.stringify(target))}</code>` });
    if (!target) {
      await step({ s: "fail", t: "Empty input rejected", d: "Checked before any DNS traffic is sent." });
      flow.validateFail = true;
      return { r: makeResult(target, { error: "Input is empty. Enter a hostname or IP address." }), flow };
    }
    if (target.length > 253) {
      await step({ s: "fail", t: `Length ${target.length} > 253`, d: "253 characters is the maximum length of a DNS name." });
      flow.validateFail = true;
      return { r: makeResult(target, { error: "Hostname is too long (max 253 characters)." }), flow };
    }
    if (target.includes(" ")) {
      await step({ s: "fail", t: "Contains a space", d: "Hostnames can't contain spaces." });
      flow.validateFail = true;
      return { r: makeResult(target, { error: "Hostname must not contain spaces." }), flow };
    }
    await step({ s: "ok", t: `Input valid (${target.length} chars, no spaces)` });

    if (target.toLowerCase() === "localhost") {
      flow.localhost = true;
      await step({ s: "ok", t: "<code>localhost</code> special-case", d: "Not a DNS name — it comes from the hosts file, so the module answers 127.0.0.1 with TTL 0 without any query." });
      const rec = { type: "A", name: "localhost", value: "127.0.0.1", ttl: 0 };
      return { r: makeResult(target, { ip: "127.0.0.1", hostname: "localhost", records: [rec] }), flow };
    }

    const records = [];
    if (NP.isIP(target)) {
      flow.ptr = true;
      const rev = reverseName(target);
      await step({ s: "info", t: `<code>ipaddress.ip_address()</code> accepted it — IPv${NP.ipVersion(target)} → reverse lookup`, d: `dns.reversename.from_address() → ${rev}` });
      let hostname = null;
      const ans = await query(rev, "PTR");
      if (ans.status === "NOERROR" && ans.answer.some((a) => a.type === "PTR")) {
        collect(ans.answer, records);
        hostname = records.find((r) => r.type === "PTR").value;
        await step({ s: "ok", t: `PTR → <code>${esc(hostname)}</code>` });
      } else {
        await step({ s: "skip", t: `PTR lookup failed (${ans.status}) — swallowed by <code>except DNSException: pass</code>`, d: "The input already is an IP, so the result is still SUCCESS with hostname None." });
      }
      return { r: makeResult(target, { ip: target, hostname, records }), flow };
    }

    flow.forward = true;
    await step({ s: "info", t: "Not an IP address → forward lookup: A, then AAAA, then MX", d: `Resolver: ${mode === "live" ? "Cloudflare DNS-over-HTTPS (live)" : "simulated zone data"} · lifetime 5 s per query` });
    let lastError = null;
    for (const qtype of ["A", "AAAA", "MX"]) {
      const ans = await query(target, qtype);
      if (ans.status === "NXDOMAIN") {
        await step({ s: "fail", t: `${qtype} → NXDOMAIN`, d: "The name doesn't exist, so the loop stops immediately and returns an error." });
        flow.nx = true;
        return { r: makeResult(target, { error: `'${target}' does not exist (NXDOMAIN).` }), flow };
      }
      if (ans.status === "SERVFAIL") {
        lastError = "No DNS server could answer the query.";
        await step({ s: "fail", t: `${qtype} → NoNameservers`, d: "Error remembered in last_error; the loop continues." });
        continue;
      }
      if (ans.status === "TIMEOUT") {
        lastError = "DNS query timed out.";
        await step({ s: "fail", t: `${qtype} → Timeout (5 s)`, d: "Error remembered in last_error; the loop continues." });
        continue;
      }
      if (!ans.answer.some((a) => a.type === qtype)) {
        await step({ s: "skip", t: `${qtype} → NoAnswer, <code>continue</code>`, d: "The name exists but has no record of this type." });
        continue;
      }
      const { added, dup } = collect(ans.answer, records);
      const cn = ans.answer.filter((a) => a.type === "CNAME").length;
      await step({
        s: "ok",
        t: `${qtype} → ${ans.answer.filter((a) => a.type === qtype).length} record(s)${cn ? ` via ${cn} CNAME` : ""}`,
        d: `_collect(): ${added} added${dup ? `, ${dup} duplicate(s) skipped (the CNAME appears in every answer)` : ""}`,
      });
    }

    records.sort((a, b) => (TYPE_ORDER.includes(a.type) ? TYPE_ORDER.indexOf(a.type) : 99) - (TYPE_ORDER.includes(b.type) ? TYPE_ORDER.indexOf(b.type) : 99));
    flow.sort = true;
    await step({ s: "info", t: "Sorted by TYPE_ORDER: CNAME, A, AAAA, MX, PTR" });

    const addresses = records.filter((r) => r.type === "A" || r.type === "AAAA").map((r) => r.value);
    if (!addresses.length) {
      await step({ s: "fail", t: "No A/AAAA record collected", d: "Without an address the lookup is FAILED, even if MX records were found." });
      return { r: makeResult(target, { records, error: lastError || `No IP address (A/AAAA) record found for '${target}'.` }), flow };
    }
    const a = records.find((r) => r.type === "A");
    const mainIP = a ? a.value : addresses[0];
    flow.pick = true;
    await step({ s: "ok", t: `Main IP = <code>${esc(mainIP)}</code>`, d: a ? "The first A (IPv4) record is preferred." : "No A record, so the first AAAA (IPv6) record is used." });
    return { r: makeResult(target, { ip: mainIP, hostname: target, records }), flow };
  }

  function describeRecordUsed(r) {
    const used = r.record_used;
    if (!r.success || used === null) return [];
    if (used === "CNAME") {
      const lines = ["Resource record used : CNAME (alias)"];
      for (const [alias, real] of r.cname_chain) lines.push(`  ${alias} is an alias for ${real}`);
      lines.push(`  the ${r.ip_version === 4 ? "A" : "AAAA"} record of the real name gave the IP`);
      return lines;
    }
    if (used === "PTR") return ["Resource record used : PTR (reverse lookup of the IP)"];
    return [`Resource record used : ${used} (direct, not an alias)`];
  }

  function cliOutput(r) {
    const L = [`<span class="prompt">$ python dns/dns_lookup.py ${esc(r.target ?? "")}</span>`, "", "[1] DNS RESOLUTION", "", `Query    : ${esc(r.target)}`];
    for (const rec of r.records) L.push(`<span class="c-vio">${esc(rec.type.padEnd(8))}</span> : ${esc(rec.name)} -&gt; <span class="c-teal">${esc(rec.value)}</span>   <span class="c-dim">(TTL ${rec.ttl}s)</span>`);
    if (r.success) {
      L.push("", `Main IP  : <span class="c-ok">${esc(r.ip)}</span> (IPv${r.ip_version})`, "");
      describeRecordUsed(r).forEach((l) => L.push(esc(l)));
      L.push("");
    }
    L.push(`Status   : <span class="${r.success ? "c-ok" : "c-bad"}">${r.status}</span>`);
    if (r.error) L.push(`Error    : <span class="c-bad">${esc(r.error)}</span>`);
    return L.join("\n");
  }

  // ---------------- UI ----------------
  const ui = {};
  function renderFlow(flow, done) {
    const set = (name, cls) => {
      const n = $(`#dns-flow [data-node="${name}"]`);
      n.className = "node " + (cls || "");
    };
    set("validate", flow.validateFail ? "fail" : flow.validate ? "on" : "");
    set("localhost", flow.localhost ? "on" : done ? "off" : "");
    set("ptr", flow.ptr ? "on" : done ? "off" : "");
    set("forward", flow.nx ? "fail" : flow.forward ? "on" : done ? "off" : "");
    set("sort", flow.sort ? "on" : done ? "off" : "");
    set("pick", flow.pick || flow.localhost || flow.ptr ? "on" : done ? "off" : "");
  }

  function renderAnswer(r) {
    const chain = $("#dns-chain");
    if (!r.success) {
      chain.innerHTML = `<div class="empty" style="flex:1">${esc(r.error)}</div>`;
    } else if (r.record_used === "PTR" || (NP.isIP(r.target) && !r.hostname)) {
      chain.innerHTML = `<div class="box">${esc(r.target)}<small>input IP</small></div><div class="link">PTR</div><div class="box ${r.hostname ? "ip" : ""}">${esc(r.hostname || "None")}<small>hostname</small></div>`;
    } else {
      let html = `<div class="box">${esc(r.target)}<small>query</small></div>`;
      r.cname_chain.forEach(([, real]) => (html += `<div class="link">CNAME</div><div class="box">${esc(real)}<small>canonical name</small></div>`));
      html += `<div class="link">${r.ip_version === 4 ? "A" : "AAAA"}</div><div class="box ip">${esc(r.ip)}<small>main IP · IPv${r.ip_version}</small></div>`;
      chain.innerHTML = html;
    }
    const tb = $("#dns-records");
    tb.innerHTML = r.records.length
      ? r.records.map((x) => `<tr><td><span class="tag t-${x.type}">${x.type}</span></td><td>${esc(x.name)}</td><td>${esc(x.value)}${x.value === r.ip ? ' <span class="tag ok">main</span>' : ""}</td><td class="num">${x.ttl}s</td></tr>`).join("")
      : `<tr><td colspan="4" style="color:var(--dim)">records = []</td></tr>`;
    $("#dns-cli").innerHTML = cliOutput(r);
    $("#dns-dict").innerHTML = NP.hlPy(NP.pyRepr(r, { tuples: ["cname_chain"] }));
    const used = $("#dns-used");
    const lines = describeRecordUsed(r);
    used.textContent = lines.length ? lines.join("\n") : "describe_record_used() → []  (only explains successful lookups)";
  }

  async function run(target) {
    if (ui.busy) return null;
    ui.busy = true;
    const btn = $("#dns-run");
    btn.disabled = true;
    const pill = $("#dns-status");
    pill.className = "status-pill run";
    pill.textContent = "resolving…";
    const log = $("#dns-log");
    log.innerHTML = "";
    renderFlow({}, false);
    const t0 = performance.now();
    const { r, flow } = await resolve(target, ui.mode.value, (s, fl) => {
      const li = document.createElement("li");
      li.className = s.s;
      const ico = { ok: "✓", fail: "✕", skip: "↷", info: "›" }[s.s];
      li.innerHTML = `<span class="ico">${ico}</span><span><span class="t">${s.t}</span>${s.d ? `<span class="d">${esc(s.d)}</span>` : ""}</span>`;
      log.appendChild(li);
      renderFlow(fl, false);
    });
    renderFlow(flow, true);
    const dt = Math.round(performance.now() - t0);
    pill.className = "status-pill " + (r.success ? "ok" : "bad");
    pill.textContent = `${r.status} · ${dt} ms`;
    renderAnswer(r);
    $("#dns-handoff").hidden = !r.success;
    ui.last = r;
    btn.disabled = false;
    ui.busy = false;
    return r;
  }

  function init() {
    ui.mode = NP.seg($("#dns-mode"));
    const input = $("#dns-input");
    $("#dns-run").addEventListener("click", () => run(input.value));
    input.addEventListener("keydown", (e) => e.key === "Enter" && run(input.value));
    $$("#dns-presets .chip").forEach((c) =>
      c.addEventListener("click", () => {
        input.value = c.dataset.v;
        run(c.dataset.v);
      })
    );
    $("#dns-to-ping").addEventListener("click", () => ui.last && (location.href = NP.pageUrl("ping.html", { target: ui.last.ip, run: 1 })));
    $("#dns-to-trace").addEventListener("click", () => ui.last && (location.href = NP.pageUrl("traceroute.html", { target: ui.last.ip, run: 1 })));
    const t = NP.params.get("target");
    if (t !== null) {
      input.value = t;
      if (NP.params.has("run")) run(t);
    }
  }

  NP.dns = {
    init,
    // Headless resolve() for the overview pipeline.
    resolve: async (t, mode = "live") => (await resolve(t, mode, () => {})).r,
  };
})();
