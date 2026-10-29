/* Page wiring: per-page module init, theme toggle and the overview pipeline. */
(function () {
  const { $, esc } = NP;

  NP.initTabs();
  if ($("#dns-run")) NP.dns.init();
  if ($("#ping-run")) NP.ping.init();
  if ($("#tr-run")) NP.trace.init();
  if ($("#an-input")) NP.analysis.init();

  // Light / dark toggle (initial theme is set by the inline script in <head>).
  const root = document.documentElement;
  const setTheme = (t, save) => {
    root.dataset.theme = t;
    if (save) {
      try {
        localStorage.setItem("np-theme", t);
      } catch (e) {}
    }
    NP.emit("theme", t);
  };
  $("#theme-toggle").addEventListener("click", () => setTheme(root.dataset.theme === "dark" ? "light" : "dark", true));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    let saved = null;
    try {
      saved = localStorage.getItem("np-theme");
    } catch (err) {}
    if (!saved) setTheme(e.matches ? "dark" : "light", false);
  });

  // Dock shrinks while scrolling down and returns on scroll up; the sky pauses during scrolling.
  let lastY = window.scrollY;
  let scrollTimer = null;
  window.addEventListener(
    "scroll",
    () => {
      const y = window.scrollY;
      if (Math.abs(y - lastY) > 6) {
        root.classList.toggle("dock-compact", y > lastY && y > 140);
        lastY = y;
      }
      root.classList.add("is-scrolling");
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => root.classList.remove("is-scrolling"), 160);
    },
    { passive: true }
  );

  // Glass catches light under the pointer: feed the cursor position to the surfaces it is over.
  const GLASS = ".panel, .step, .stage, .pager-card, .spec, .chip, .btn.ghost, .dock-group, .notice, .rule, details.src";
  if (window.matchMedia("(hover: hover)").matches && !NP.reducedMotion) {
    let frame = 0;
    let e = null;
    document.addEventListener(
      "pointermove",
      (ev) => {
        e = ev;
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          for (let el = e.target.closest && e.target.closest(GLASS); el; el = el.parentElement && el.parentElement.closest(GLASS)) {
            const r = el.getBoundingClientRect();
            el.style.setProperty("--mx", `${e.clientX - r.left}px`);
            el.style.setProperty("--my", `${e.clientY - r.top}px`);
          }
        });
      },
      { passive: true }
    );
  }

  // ---- overview pipeline (index.html only) ----
  if (!$("#pipe-run")) return;

  const os = /win/i.test(navigator.platform || navigator.userAgent) ? "windows" : "linux";
  const stage = (name, state, html, href) => {
    const el = $(`.stage[data-stage="${name}"]`);
    el.classList.remove("running", "done", "failed");
    if (state) el.classList.add(state);
    el.querySelector(".out").innerHTML = html;
    if (href) el.href = href;
  };
  const open = '<span style="color:var(--dim)"> · open ↗</span>';

  async function pipeline() {
    const btn = $("#pipe-run");
    const target = $("#pipe-target").value;
    btn.disabled = true;
    ["dns", "ping", "trace", "analysis"].forEach((s) => stage(s, "", "waiting"));
    try {
      stage("dns", "running", "resolve(target)…");
      const r = await NP.dns.resolve(target, "live");
      const dnsHref = NP.pageUrl("dns.html", { target, run: 1 });
      if (!r.success) return stage("dns", "failed", esc(r.error) + open, dnsHref);
      stage("dns", "done", `${esc(r.ip)} <span style="color:var(--dim)">via ${r.record_used}</span>${open}`, dnsHref);

      stage("ping", "running", `ping("${esc(r.ip)}")…`);
      await NP.sleep(450);
      const p = NP.ping.simulate(r.ip, os);
      stage("ping", p.received ? "done" : "failed", (p.received ? `avg ${p.avg_rtt} ms · ${NP.pyFloat(p.packet_loss)}% loss` : "no replies") + open, NP.pageUrl("ping.html", { target: r.ip, run: 1 }));

      stage("trace", "running", `run_traceroute("${esc(r.ip)}")…`);
      await NP.sleep(450);
      const t = NP.trace.simulate(r.ip, "clean", os);
      const trHref = NP.pageUrl("traceroute.html", { target: r.ip, scenario: "clean", run: 1 });
      if (!t.path) return stage("trace", "failed", esc(t.result.error) + open, trHref);
      stage("trace", "done", `${t.result.hops.length} hops · ${t.result.reached_destination ? "reached" : "NOT reached"}${open}`, trHref);

      stage("analysis", "running", "analyze_path(result)…");
      await NP.sleep(350);
      const a = NP.analysis.analyze(t.path.hops);
      const bn = a.bottlenecks.map((b) => b.hop);
      stage("analysis", bn.length ? "failed" : "done", (bn.length ? `bottleneck at hop ${bn.join(", ")}` : "no bottlenecks") + open, NP.pageUrl("analysis.html", { path: JSON.stringify(t.path) }));
    } finally {
      btn.disabled = false;
    }
  }
  $("#pipe-run").addEventListener("click", pipeline);
  $("#pipe-target").addEventListener("keydown", (e) => e.key === "Enter" && pipeline());
})();
