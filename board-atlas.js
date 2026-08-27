/* <us-map> — state shading and the site layer as one subject.

   From the Claude Design project "US Charging Board redesign", turn 2 option 2a
   ("Atlas"). The projection frame, the CONUS/AK/HI insets, the two-pass dot
   layer and the tooltips are the design's; what changed on the way in is where
   the data comes from.

   The design's copy fetched three files it had generated from a snapshot. This
   one is handed the board's own merge instead, through `setAtlasData`. A static
   snapshot would start disagreeing with the figures printed beside it the first
   time anything refreshed — and would know nothing of the rival-network match
   fix, or of sites mapped in this session. One source of truth, packed once. */
(function () {
  let CACHE = null;
  const WAITING = [];
  const MOUNTED = new Set();

  const load = () => (CACHE ? Promise.resolve(CACHE) : new Promise((r) => WAITING.push(r)));

  /* Called by app.js after every merge. Elements already on the page are told
     to forget what they worked out and paint again — a refresh that left the
     map showing the previous snapshot would be worse than no map. */
  window.setAtlasData = (d) => {
    CACHE = d;
    while (WAITING.length) WAITING.shift()(CACHE);
    for (const el of MOUNTED) {
      el._d = CACHE;
      el._aggKey = null;
      el._index && el._index();
      el._queue ? el._queue() : el._paint && el._paint();
    }
  };

  const FRAME = {
    conus: { box: [0.13, 0.0, 1.0, 0.94], bounds: { lat0: 24, lat1: 50, lon0: -125, lon1: -66 } },
    ak: { box: [0.005, 0.55, 0.2, 0.99], bounds: null },
    hi: { box: [0.215, 0.72, 0.325, 0.99], bounds: null },
  };
  const REGION = { AK: "ak", HI: "hi" };
  const regionOf = (c) => REGION[c] || (c === "PR" ? null : "conus");

  const BOUNDS = {};
  function ringBounds(st, key) {
    if (key && BOUNDS[key]) return BOUNDS[key];
    let lat0 = 90, lat1 = -90, lon0 = 180, lon1 = -180;
    for (const r of st.rings) for (const [lon, lat] of r) {
      lat0 = Math.min(lat0, lat); lat1 = Math.max(lat1, lat);
      lon0 = Math.min(lon0, lon); lon1 = Math.max(lon1, lon);
    }
    const b = { lat0, lat1, lon0, lon1 };
    if (key) BOUNDS[key] = b;
    return b;
  }
  function fit(box, b, W, H) {
    const [bx0, by0, bx1, by1] = box;
    const x0 = bx0 * W, y0 = by0 * H, bw = (bx1 - bx0) * W, bh = (by1 - by0) * H;
    const kx = Math.cos((((b.lat0 + b.lat1) / 2) * Math.PI) / 180);
    const gw = (b.lon1 - b.lon0) * kx, gh = b.lat1 - b.lat0;
    const s = Math.min(bw / gw, bh / gh);
    const ox = x0 + (bw - gw * s) / 2, oy = y0 + (bh - gh * s) / 2;
    return (lon, lat) => [ox + (lon - b.lon0) * kx * s, oy + (b.lat1 - lat) * s];
  }
  function projectors(outline, W, H) {
    FRAME.ak.bounds = FRAME.ak.bounds || (outline.AK ? ringBounds(outline.AK, "AK") : null);
    FRAME.hi.bounds = FRAME.hi.bounds || (outline.HI ? ringBounds(outline.HI, "HI") : null);
    const out = {};
    for (const k of ["conus", "ak", "hi"]) out[k] = FRAME[k].bounds ? fit(FRAME[k].box, FRAME[k].bounds, W, H) : null;
    return out;
  }
  function pad(b, f) {
    const dlat = (b.lat1 - b.lat0) * f, dlon = (b.lon1 - b.lon0) * f;
    return { lat0: b.lat0 - dlat, lat1: b.lat1 + dlat, lon0: b.lon0 - dlon, lon1: b.lon1 + dlon };
  }

  /* The host may hand these over as properties or as attributes depending on how
     the element is mounted, so every setting is read through one accessor. */
  const ATTRS = ["metric", "dots", "brand", "focus", "ratio", "labels", "accent"];
  function wireCfg(el) {
    el._cfg = {};
    for (const a of ATTRS) {
      /* A value assigned before upgrade sits as an own property and would shadow
         the accessor, so it is taken over rather than skipped. */
      let seed;
      if (Object.prototype.hasOwnProperty.call(el, a)) { seed = el[a]; delete el[a]; }
      Object.defineProperty(el, a, {
        configurable: true,
        get() { return this._cfg[a]; },
        set(v) { this._cfg[a] = v; this._queue ? this._queue() : this._paint && this._paint(); },
      });
      if (seed !== undefined) el._cfg[a] = seed;
    }
  }
  const cfg = (el, name) => (el._cfg && el._cfg[name] != null ? el._cfg[name] : el.getAttribute(name));
  const flag = (v) => v != null && v !== false && v !== "false";

  function hitState(outline, proj, mx, my) {
    for (const [code, st] of Object.entries(outline)) {
      const key = regionOf(code);
      if (!key || !proj[key]) continue;
      const px = proj[key];
      for (const ring of st.rings) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [xi, yi] = px(ring[i][0], ring[i][1]);
          const [xj, yj] = px(ring[j][0], ring[j][1]);
          if (yi > my !== yj > my && mx < ((xj - xi) * (my - yi)) / (yj - yi) + xi) inside = !inside;
        }
        if (inside) return code;
      }
    }
    return null;
  }

  /* Two layers on one canvas: states shaded by the metric, then every site as a
     dot — grey where OpenStreetMap has it, accent where it is missing. */
  class UsMap extends HTMLElement {
    connectedCallback() {
      if (this._built) return;
      this._built = true;
      wireCfg(this);
      Object.assign(this.style, { display: "block", position: "relative", cursor: "pointer" });
      this._cv = document.createElement("canvas");
      Object.assign(this._cv.style, { display: "block", width: "100%" });
      this._tip = document.createElement("div");
      Object.assign(this._tip.style, {
        position: "absolute", pointerEvents: "none", opacity: "0", zIndex: "5",
        transform: "translate(-50%,-135%)", whiteSpace: "nowrap",
        font: "500 11px/1.45 Archivo, system-ui, sans-serif", letterSpacing: ".02em",
        padding: "6px 9px", background: "#f8f4f4", color: "#201e1d", transition: "opacity .1s ease",
      });
      this.append(this._cv, this._tip);
      this._cv.addEventListener("mousemove", (e) => this._hover(e));
      this._cv.addEventListener("mouseleave", () => { this._tip.style.opacity = "0"; this._hi = null; this._queue(); });
      this._cv.addEventListener("click", () => {
        this.dispatchEvent(new CustomEvent("map-pick", { detail: { code: this._hi || null }, bubbles: true, composed: true }));
      });
      MOUNTED.add(this);
      load().then((d) => { this._d = d; this._index(); this._paint(); });
      this._ro = new ResizeObserver(() => this._queue());
      this._ro.observe(this);
    }
    disconnectedCallback() { MOUNTED.delete(this); this._ro && this._ro.disconnect(); }
    static get observedAttributes() { return ["metric", "dots", "brand", "focus", "ratio", "labels"]; }
    attributeChangedCallback() { this._queue(); }
    _queue() {
      /* A timer, not requestAnimationFrame: a backgrounded tab throttles rAF and
         a repaint would sit unfired. */
      if (this._t) clearTimeout(this._t);
      this._t = setTimeout(() => { this._t = 0; this._paint(); }, 0);
    }

    _index() {
      const p = this._d && this._d.points;
      if (!p) return;
      this._netIdx = new Map(p.nets.map((n, i) => [n, i]));
      this._stCode = p.states;
    }

    /* Per-state figures for the current brand filter, recomputed from the point
       layer so the shading, the tooltip and the dots can never disagree. */
    _agg() {
      const p = this._d.points, brand = cfg(this, "brand") || "";
      const key = brand || "*";
      if (this._aggKey === key && this._aggVal) return this._aggVal;
      const want = brand ? this._netIdx.get(brand) : -2;
      const out = {};
      if (p) {
        const { d, stride } = p;
        for (let i = 0; i < d.length; i += stride) {
          if (want !== -2 && d[i + 2] !== want) continue;
          const si = d[i + 4];
          if (si < 0) continue;
          const c = this._stCode[si];
          const e = out[c] || (out[c] = { sites: 0, ports: 0, mapped: 0 });
          e.sites++; e.ports += d[i + 3]; if (d[i + 5] & 1) e.mapped++;
        }
      }
      this._aggKey = key; this._aggVal = out;
      return out;
    }

    _paint() {
      if (!this._d) return;
      const W = Math.max(320, this.getBoundingClientRect().width);
      const H = Math.round(W * parseFloat(cfg(this, "ratio") || "0.58"));
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cv = this._cv;
      cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + "px";
      const ctx = cv.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      const focus = cfg(this, "focus") || "";
      const outline = this._d.outline;
      let proj;
      if (focus && outline[focus]) {
        const px = fit([0.02, 0.03, 0.98, 0.97], pad(ringBounds(outline[focus], focus), 0.06), W, H);
        proj = { conus: px, ak: px, hi: px };
      } else {
        proj = projectors(outline, W, H);
      }
      this._proj = proj; this._focus = focus;

      const metric = cfg(this, "metric") || "mapped";
      const agg = this._agg();
      const vals = new Map();
      for (const [c, st] of Object.entries(this._d.states)) {
        const a = agg[c] || { sites: 0, ports: 0, mapped: 0 };
        let v = null;
        if (metric === "mapped") v = a.sites >= 8 ? (a.mapped / a.sites) * 100 : null;
        else if (metric === "gap") v = a.sites ? a.sites - a.mapped : null;
        else if (metric === "rate") v = st.pop && a.ports ? (a.ports / st.pop) * 1e5 : null;
        else v = a.sites || null;
        if (v != null) vals.set(c, v);
      }
      const sorted = [...vals.values()].sort((a, b) => a - b);
      const lo = sorted[0] ?? 0, hi = sorted[sorted.length - 1] ?? 1;
      const norm = (v) => (hi === lo ? 0.5 : (v - lo) / (hi - lo));
      this._vals = vals; this._metric = metric; this._agg2 = agg;

      /* Shading stays neutral so the accent belongs to the dots alone. */
      const shade = (t) => `oklch(${(12 + t * 18).toFixed(1)}% ${(0.004 + t * 0.010).toFixed(3)} 40)`;

      ctx.lineJoin = "round";
      for (const [code, st] of Object.entries(outline)) {
        const key = regionOf(code);
        if (!key || !proj[key]) continue;
        const px = proj[key];
        const v = vals.get(code);
        const dim = focus && code !== focus;
        const sel = code === (this._hi || "") || code === focus;
        for (const ring of st.rings) {
          ctx.beginPath();
          ring.forEach(([lon, lat], i) => { const [x, y] = px(lon, lat); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
          ctx.closePath();
          ctx.fillStyle = v == null ? "#141313" : shade(norm(v));
          ctx.globalAlpha = dim ? 0.45 : 1;
          ctx.fill();
          ctx.strokeStyle = sel && !dim ? "#f8f4f4" : "#0e0d0d";
          ctx.lineWidth = sel && !dim ? 1.6 : 0.9;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }

      const mode = cfg(this, "dots") || "both";
      this._pts = [];
      if (mode !== "none" && this._d.points) {
        const p = this._d.points, { d, stride } = p;
        const brand = cfg(this, "brand") || "";
        const want = brand ? this._netIdx.get(brand) : -2;
        const r = focus ? 3.1 : 1.7;
        const fi = focus ? this._stCode.indexOf(focus) : -1;
        const pass = (flagWanted) => {
          for (let i = 0; i < d.length; i += stride) {
            if (want !== -2 && d[i + 2] !== want) continue;
            const on = (d[i + 5] & 1) === 1;
            if (flagWanted !== on) continue;
            if (mode === "unmapped" && on) continue;
            if (mode === "mapped" && !on) continue;
            const si = d[i + 4];
            const code = si >= 0 ? this._stCode[si] : null;
            const key = code ? regionOf(code) : "conus";
            const px = proj[key] || proj.conus;
            if (!px) continue;
            const [x, y] = px(d[i + 1] / 1e4, d[i] / 1e4);
            if (x < -8 || y < -8 || x > W + 8 || y > H + 8) continue;
            ctx.globalAlpha = fi >= 0 && si !== fi ? 0.3 : 1;
            ctx.beginPath();
            ctx.arc(x, y, r, 0, 6.2832);
            ctx.fill();
            if (focus) this._pts.push(x, y, d[i + 2], d[i + 3], d[i + 5]);
          }
          ctx.globalAlpha = 1;
        };
        if (mode !== "unmapped") { ctx.fillStyle = "#b9b5b5"; pass(true); }
        if (mode !== "mapped") { ctx.fillStyle = cfg(this, "accent") || "#ff563c"; pass(false); }
      }

      if (flag(cfg(this, "labels")) && !focus) {
        ctx.font = "700 9px Archivo, system-ui, sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillStyle = "rgba(248,244,244,.5)";
        for (const [code, st] of Object.entries(outline)) {
          const key = regionOf(code);
          if (!key || !proj[key]) continue;
          const b = ringBounds(st, code);
          const [x, y] = proj[key]((b.lon0 + b.lon1) / 2, (b.lat0 + b.lat1) / 2);
          ctx.fillText(code, x, y);
        }
      }

      const unit = { mapped: "% of sites on the map", gap: "sites missing", rate: "ports per 100k people", count: "sites" }[metric];
      this.dispatchEvent(new CustomEvent("map-range", {
        detail: { lo, hi, unit, metric }, bubbles: true, composed: true,
      }));
    }

    _hover(e) {
      if (!this._d || !this._proj) return;
      const r = this._cv.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      if (this._focus && this._pts && this._pts.length) {
        let best = -1, bd = 81;
        for (let i = 0; i < this._pts.length; i += 5) {
          const dx = this._pts[i] - mx, dy = this._pts[i + 1] - my, d2 = dx * dx + dy * dy;
          if (d2 < bd) { bd = d2; best = i; }
        }
        if (best >= 0) {
          const net = this._d.points.nets[this._pts[best + 2]];
          const ports = this._pts[best + 3], on = (this._pts[best + 4] & 1) === 1;
          this._tip.innerHTML = '<b style="font-weight:700">' + net + "</b> · " + ports + " DC ports<br>" +
            '<span style="color:' + (on ? "#4f4b4b" : "#c8300f") + '">' + (on ? "on OpenStreetMap" : "missing from the map") + "</span>";
          this._tip.style.left = this._pts[best] + "px";
          this._tip.style.top = this._pts[best + 1] + "px";
          this._tip.style.opacity = "1";
          return;
        }
      }
      const found = hitState(this._d.outline, this._proj, mx, my);
      if (found !== this._hi) { this._hi = found; this._queue(); }
      if (!found) { this._tip.style.opacity = "0"; return; }
      const st = this._d.states[found] || {};
      const a = (this._agg2 || {})[found] || { sites: 0, ports: 0, mapped: 0 };
      const pct = a.sites ? Math.round((a.mapped / a.sites) * 100) : 0;
      this._tip.innerHTML = '<b style="font-weight:700">' + (st.name || found) + "</b> · " +
        a.sites.toLocaleString() + " sites, " + a.ports.toLocaleString() + " ports<br>" +
        '<span style="color:#4f4b4b">' + pct + "% on the map · </span>" +
        '<span style="color:#c8300f">' + (a.sites - a.mapped).toLocaleString() + " missing</span>";
      this._tip.style.left = mx + "px"; this._tip.style.top = my + "px"; this._tip.style.opacity = "1";
    }
  }

  if (!customElements.get("us-map")) customElements.define("us-map", UsMap);
})();
