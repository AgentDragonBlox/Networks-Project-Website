/* Shared helpers: DOM, seeded randomness, Python-style formatting, IP parsing, tabs, event bus. */
(function () {
  const NP = (window.NP = {});

  NP.$ = (sel, root = document) => root.querySelector(sel);
  NP.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  NP.esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  NP.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  NP.sleep = (ms) => new Promise((r) => setTimeout(r, NP.reducedMotion ? 0 : ms));

  // ---- seeded random (xmur3 + mulberry32) so a target always gets the same simulated network ----
  function xmur3(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return () => {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return (h ^= h >>> 16) >>> 0;
    };
  }
  function mulberry32(a) {
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  NP.rng = (seed) => mulberry32(xmur3(String(seed))());
  NP.gauss = (rng) => {
    let u = 0, v = 0;
    while (!u) u = rng();
    while (!v) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  NP.randInt = (rng, a, b) => a + Math.floor(rng() * (b - a + 1));

  // ---- Python-flavoured number formatting ----
  NP.round = (x, n = 2) => {
    const f = 10 ** n;
    return Math.round((x + Number.EPSILON) * f) / f;
  };
  NP.pyFloat = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x)); // repr(float)
  NP.center = (s, w) => {
    // CPython's str.center() padding rule
    const m = w - s.length;
    if (m <= 0) return s;
    const left = Math.floor(m / 2) + (m & w & 1);
    return " ".repeat(left) + s + " ".repeat(m - left);
  };
  NP.mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  NP.pstdev = (a) => {
    const m = NP.mean(a);
    return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
  };

  // ---- IP addresses (mirrors ipaddress.ip_address acceptance closely enough for the demo) ----
  const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
  NP.ipVersion = (s) => {
    if (typeof s !== "string" || !s) return null;
    if (V4.test(s)) return 4;
    if (!s.includes(":") || /[^0-9a-fA-F:.]/.test(s)) return null;
    try {
      new URL(`http://[${s}]/`);
      return 6;
    } catch {
      return null;
    }
  };
  NP.isIP = (s) => NP.ipVersion(s) !== null;
  NP.normIP = (s) => (NP.ipVersion(s) === 6 ? new URL(`http://[${s}]/`).hostname.slice(1, -1) : s);
  NP.sameIP = (a, b) => NP.isIP(a) && NP.isIP(b) && NP.normIP(a) === NP.normIP(b);

  // Deterministic "public" IP for a hostname in simulations.
  NP.simIP = (name) => {
    if (NP.isIP(name)) return name;
    const known = NP.knownHosts && NP.knownHosts[String(name).toLowerCase()];
    if (known) return known;
    const r = NP.rng("ip:" + String(name).toLowerCase());
    const firsts = [23, 34, 52, 64, 76, 93, 104, 142, 151, 172, 185, 199, 203];
    return [firsts[Math.floor(r() * firsts.length)], NP.randInt(r, 1, 254), NP.randInt(r, 0, 255), NP.randInt(r, 1, 254)].join(".");
  };

  // ---- Python repr() and json.dumps(indent=2) renderers ----
  const pyStr = (s) => "'" + String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
  NP.pyRepr = (root, opts = {}) => {
    const floats = new Set(opts.floats || []);
    const tuples = new Set(opts.tuples || []);
    const IND = "    ";
    function rep(v, key, depth, asTuple) {
      if (v === null || v === undefined) return "None";
      if (v === true) return "True";
      if (v === false) return "False";
      if (typeof v === "number") return floats.has(key) ? NP.pyFloat(v) : String(v);
      if (typeof v === "string") return pyStr(v);
      const pad = IND.repeat(depth + 1), end = IND.repeat(depth);
      if (Array.isArray(v)) {
        const [o, c] = asTuple ? ["(", ")"] : ["[", "]"];
        if (!v.length) return o + c;
        const kids = v.map((x) => rep(x, key, depth + 1, !asTuple && tuples.has(key) && Array.isArray(x)));
        const multi = v.some((x) => x && typeof x === "object" && !Array.isArray(x));
        return multi ? `${o}\n${pad}${kids.join(`,\n${pad}`)}\n${end}${c}` : `${o}${kids.join(", ")}${c}`;
      }
      const keys = Object.keys(v);
      if (!keys.length) return "{}";
      const kids = keys.map((k) => `${pyStr(k)}: ${rep(v[k], k, depth + 1)}`);
      return depth === 0 || kids.join(", ").length > 76
        ? `{\n${pad}${kids.join(`,\n${pad}`)}\n${end}}`
        : `{${kids.join(", ")}}`;
    }
    return rep(root, null, 0, false);
  };
  NP.pyJson = (root, opts = {}) => {
    const floats = new Set(opts.floats || []);
    function rep(v, key, depth) {
      if (v === null || v === undefined) return "null";
      if (typeof v === "boolean") return String(v);
      if (typeof v === "number") return floats.has(key) ? NP.pyFloat(v) : String(v);
      if (typeof v === "string") return JSON.stringify(v);
      const pad = "  ".repeat(depth + 1), end = "  ".repeat(depth);
      if (Array.isArray(v)) {
        if (!v.length) return "[]";
        return `[\n${pad}${v.map((x) => rep(x, key, depth + 1)).join(`,\n${pad}`)}\n${end}]`;
      }
      const keys = Object.keys(v);
      if (!keys.length) return "{}";
      return `{\n${pad}${keys.map((k) => `${JSON.stringify(k)}: ${rep(v[k], k, depth + 1)}`).join(`,\n${pad}`)}\n${end}}`;
    }
    return rep(root, null, 0);
  };

  // Light syntax colouring for repr/JSON output.
  NP.hlPy = (text) => {
    const re = /('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")|\b(None|True|False|null|true|false)\b|(-?\b\d+(?:\.\d+)?\b)/g;
    let out = "", last = 0, m;
    while ((m = re.exec(text))) {
      out += NP.esc(text.slice(last, m.index));
      const cls = m[1] ? "py-s" : m[2] ? "py-k" : "py-n";
      out += `<span class="${cls}">${NP.esc(m[0])}</span>`;
      last = re.lastIndex;
    }
    return out + NP.esc(text.slice(last));
  };

  // ---- terminal helper ----
  NP.term = (el) => ({
    el,
    clear() { el.innerHTML = ""; },
    set(html) { el.innerHTML = html; },
    append(html, cls = "") {
      const span = document.createElement("span");
      span.className = "line-in " + cls;
      span.innerHTML = html + "\n";
      el.appendChild(span);
      el.scrollTop = el.scrollHeight;
    },
  });

  // ---- tabs ----
  NP.initTabs = (root = document) => {
    NP.$$("[data-tabs]", root).forEach((group) => {
      const btns = NP.$$(":scope > .tablist > [role=tab]", group);
      const panels = NP.$$(":scope > .tabpanel", group);
      const select = (name) => {
        btns.forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
        panels.forEach((p) => (p.hidden = p.dataset.panel !== name));
      };
      btns.forEach((b) => b.addEventListener("click", () => select(b.dataset.tab)));
      group.selectTab = select;
      select((btns.find((b) => b.getAttribute("aria-selected") === "true") || btns[0]).dataset.tab);
    });
  };

  // Segmented toggle buttons: <div class="seg" data-seg="name"><button data-val=..>
  NP.seg = (el, onChange) => {
    const btns = NP.$$("button", el);
    const api = {
      get value() { return (btns.find((b) => b.getAttribute("aria-pressed") === "true") || btns[0]).dataset.val; },
      set(v) {
        btns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.val === v)));
        onChange && onChange(v);
      },
    };
    btns.forEach((b) => b.addEventListener("click", () => api.set(b.dataset.val)));
    return api;
  };

  // ---- tiny event bus for the cross-module pipeline ----
  const subs = {};
  NP.on = (ev, fn) => (subs[ev] = subs[ev] || []).push(fn);
  NP.emit = (ev, data) => (subs[ev] || []).forEach((fn) => fn(data));

  // Theme colours for SVG charts, read live from the CSS custom properties (NP.col.chGrid -> --ch-grid).
  NP.col = new Proxy({}, {
    get: (_, k) => getComputedStyle(document.documentElement).getPropertyValue("--" + String(k).replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())).trim(),
  });

  // Query-string hand-offs between pages (e.g. ping.html?target=1.1.1.1&run=1).
  NP.params = new URLSearchParams(location.search);
  NP.pageUrl = (page, params) => `${page}?${new URLSearchParams(params)}`;

  NP.fmtMs = (v) => (v == null ? "—" : `${NP.round(v, 2)}`);
})();
