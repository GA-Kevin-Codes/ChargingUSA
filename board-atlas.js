/* <us-map> — state shading and the site layer as one subject.

   The projection frame, the CONUS/AK/HI insets and the two-pass dot layer came
   with the "Atlas" layout. Its colours used to be written into this file for
   one dark ground; they are read from the stylesheet now (`--map-*`), at the
   moment of painting, so the map follows the page between day and night
   instead of being the one panel that does not.

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
      el._aggKey = null; el._caggKey = null;
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
  const ATTRS = ["metric", "dots", "brand", "focus", "county", "ratio", "labels", "accent"];
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
  // Network and state names come from the feeds; they reach the tooltip as text.
  const h = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const cfg = (el, name) => (el._cfg && el._cfg[name] != null ? el._cfg[name] : el.getAttribute(name));

  /* The map's palette, as the stylesheet has it right now. A canvas keeps
     whatever it was painted with, so this is asked again on every paint rather
     than once at load. The fallbacks are the daytime values: a token that is
     missing should draw something legible, not transparent black. */
  const PALETTE = {
    lo: ["--map-lo", "#e9e3d3"], hi: ["--map-hi", "#94a8ba"], none: ["--map-null", "#f4f0e6"],
    line: ["--map-line", "#fbf9f4"], pick: ["--map-pick", "#18222d"], label: ["--map-label", "#18222d99"],
    on: ["--map-on", "#0f7d57"], off: ["--map-off", "#ee6a1e"],
    done: ["--map-done", "#bfe3cf"], doneInk: ["--map-done-ink", "#0a6947"],
  };
  function palette(el) {
    const css = getComputedStyle(el);
    const out = {};
    for (const [k, [name, fallback]] of Object.entries(PALETTE)) out[k] = css.getPropertyValue(name).trim() || fallback;
    return out;
  }
  const rgb = (hex) => {
    const m = /^#?([0-9a-f]{6})/i.exec(hex) || /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
    if (!m) return [128, 128, 128];
    const v = m.length === 2 ? m[1] : m[1] + m[1] + m[2] + m[2] + m[3] + m[3];
    return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
  };
  /* One ramp between two ends. Mixed in linear light rather than on the raw
     byte values, so the middle of the scale is a middle tone and not a murky
     one. */
  const lin = (c) => Math.pow(c / 255, 2.2), unlin = (v) => Math.round(Math.pow(v, 1 / 2.2) * 255);
  function ramp(lo, hi) {
    const a = rgb(lo).map(lin), b = rgb(hi).map(lin);
    return (t) => `rgb(${a.map((v, i) => unlin(v + (b[i] - v) * t)).join(",")})`;
  }
  const flag = (v) => v != null && v !== false && v !== "false";

  const inRingsAt = (lon, lat, rings) => {
    let inside = false;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
    return inside;
  };

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
      // styled by the page (.map-tip), so it changes with the theme like the rest
      this._tip = document.createElement("div");
      this._tip.className = "map-tip";
      this._tip.setAttribute("role", "status");
      this.append(this._cv, this._tip);
      this._cv.addEventListener("mousemove", (e) => this._hover(e));
      this._cv.addEventListener("mouseleave", () => {
        this._tip.style.opacity = "0"; this._hi = null; this._hiCounty = null; this._hiSite = null; this._queue();
      });
      /* What a click lands on, most specific first: a site, then a county,
         then a state. The hover worked all three out; the click reports the
         one it found. A site used to report its state instead, and since that
         was the state already open, the map zoomed out. */
      this._cv.addEventListener("click", (e) => {
        this._hover(e);
        const detail = this._hiSite != null ? { site: this._hiSite }
          : this._hiCounty ? { county: this._hiCounty, code: this._focus }
          : { code: this._hi || null };
        this.dispatchEvent(new CustomEvent("map-pick", { detail, bubbles: true, composed: true }));
      });
      MOUNTED.add(this);
      load().then((d) => { this._d = d; this._index(); this._paint(); });
      this._ro = new ResizeObserver(() => this._queue());
      this._ro.observe(this);
    }
    disconnectedCallback() { MOUNTED.delete(this); this._ro && this._ro.disconnect(); }
    static get observedAttributes() { return ["metric", "dots", "brand", "focus", "county", "ratio", "labels"]; }
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

    /* The same, per county of the open state, keyed by the county's place in
       its list. Only meaningful while a state is open and its counties are
       loaded; empty otherwise. */
    _cagg() {
      const p = this._d.points, brand = cfg(this, "brand") || "";
      const key = `${brand || "*"}|${this._d.counties?.state || ""}`;
      if (this._caggKey === key && this._caggVal) return this._caggVal;
      const want = brand ? this._netIdx.get(brand) : -2;
      const out = new Map();
      if (p && this._d.counties) {
        const { d, stride } = p;
        for (let i = 0; i < d.length; i += stride) {
          const ci = d[i + 6];
          if (ci == null || ci < 0 || (want !== -2 && d[i + 2] !== want)) continue;
          const e = out.get(ci) || { sites: 0, ports: 0, mapped: 0 };
          e.sites++; e.ports += d[i + 3]; if (d[i + 5] & 1) e.mapped++;
          out.set(ci, e);
        }
      }
      this._caggKey = key; this._caggVal = out;
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
      // the open state's counties, if they have arrived and are this state's
      const cl = focus && this._d.counties?.state === focus ? this._d.counties.list : null;
      const county = cl ? cfg(this, "county") || "" : "";
      const ci = county ? cl.findIndex((c) => c.id === county) : -1;
      let proj;
      if (ci >= 0) {
        const px = fit([0.02, 0.03, 0.98, 0.97], pad(cl[ci].b, 0.08), W, H);
        proj = { conus: px, ak: px, hi: px };
      } else if (focus && outline[focus]) {
        const px = fit([0.02, 0.03, 0.98, 0.97], pad(ringBounds(outline[focus], focus), 0.06), W, H);
        proj = { conus: px, ak: px, hi: px };
      } else {
        proj = projectors(outline, W, H);
      }
      /* A hovered county belongs to the state it was hovered in. Opening
         another state leaves the old index behind, pointing at whatever county
         happens to have that number in the new list — or past the end of it. */
      if (this._cl !== cl) { this._hiCounty = null; this._hiCountyIx = null; }
      this._proj = proj; this._focus = focus; this._cl = cl; this._ci = ci;

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
      /* Inside an open state the shading is by county, on the county figures —
         except per person, which needs a county population the board does not
         carry; there the counties are outlined and left unshaded. */
      const cagg = cl ? this._cagg() : null;
      const cvals = new Map();
      if (cl && metric !== "rate") {
        for (let i = 0; i < cl.length; i++) {
          const a = cagg.get(i);
          if (!a) continue;
          const v = metric === "mapped" ? (a.sites >= 3 ? (a.mapped / a.sites) * 100 : null)
            : metric === "gap" ? a.sites - a.mapped : a.sites;
          if (v != null) cvals.set(i, v);
        }
      }
      const shaded = cl && metric !== "rate" ? cvals : vals;
      const sorted = [...shaded.values()].sort((a, b) => a - b);
      const lo = sorted[0] ?? 0, hi = sorted[sorted.length - 1] ?? 1;
      const norm = (v) => (hi === lo ? 0.5 : (v - lo) / (hi - lo));
      this._vals = vals; this._metric = metric; this._agg2 = agg; this._cagg2 = cagg;

      /* Shading stays neutral so colour belongs to the dots alone. */
      const pal = palette(this);
      const shade = ramp(pal.lo, pal.hi);

      ctx.lineJoin = "round";
      for (const [code, st] of Object.entries(outline)) {
        const key = regionOf(code);
        if (!key || !proj[key]) continue;
        const px = proj[key];
        const v = vals.get(code);
        const dim = focus && code !== focus;
        for (const ring of st.rings) {
          ctx.beginPath();
          ring.forEach(([lon, lat], i) => { const [x, y] = px(lon, lat); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
          ctx.closePath();
          /* A state with nothing missing is filled in its own colour whatever
             the map is shading by. "Finished" is not a point on any of the
             four scales — on the missing-sites scale it is the bottom, on the
             percent scale the top — and it is the one thing about a state a
             mapper most wants to see at a glance. */
          const a = agg[code];
          const done = !!a && a.sites > 0 && a.mapped === a.sites;
          ctx.fillStyle = done ? pal.done : v == null ? pal.none : shade(norm(v));
          ctx.globalAlpha = dim ? 0.45 : 1;
          ctx.fill();
          ctx.strokeStyle = pal.line;
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
      /* The picked state's outline goes on after every fill. Drawn in the same
         pass it was half painted over by whichever neighbours came later in
         the list, so the highlight had gaps along shared borders. */
      const picked = [...new Set([this._hi, focus].filter((c) => c && outline[c]))];
      for (const code of picked) {
        const key = regionOf(code);
        if (!key || !proj[key]) continue;
        const px = proj[key];
        ctx.strokeStyle = pal.pick;
        ctx.lineWidth = 1.8;
        for (const ring of outline[code].rings) {
          ctx.beginPath();
          ring.forEach(([lon, lat], i) => { const [x, y] = px(lon, lat); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
          ctx.closePath();
          ctx.stroke();
        }
      }

      if (cl) {
        const px = proj.conus;
        const path = (rings) => {
          ctx.beginPath();
          for (const ring of rings) {
            ring.forEach(([lon, lat], i) => { const [x, y] = px(lon, lat); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
            ctx.closePath();
          }
        };
        for (let i = 0; i < cl.length; i++) {
          const c = cl[i], a = cagg.get(i), v = cvals.get(i);
          path(c.rings);
          const done = !!a && a.sites > 0 && a.mapped === a.sites;
          ctx.globalAlpha = ci >= 0 && i !== ci ? 0.4 : 1;
          if (metric !== "rate") {
            ctx.fillStyle = done ? pal.done : v == null ? pal.none : shade(norm(v));
            ctx.fill("evenodd");
          }
          ctx.strokeStyle = pal.line; ctx.lineWidth = 0.8;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        for (const i of new Set([this._hiCountyIx, ci].filter((x) => x != null && x >= 0 && x < cl.length))) {
          path(cl[i].rings);
          ctx.strokeStyle = pal.pick; ctx.lineWidth = 1.8; ctx.stroke();
        }
        // county names once there is room for them: inside one county, or a small state
        if (ci < 0 && cl.length <= 30 || ci >= 0) {
          ctx.font = "700 9.5px Overpass, system-ui, sans-serif";
          ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = pal.label;
          for (let i = 0; i < cl.length; i++) {
            if (ci >= 0 && i !== ci) continue;
            const b = cl[i].b;
            const [x, y] = px((b.lon0 + b.lon1) / 2, ci >= 0 ? b.lat1 : (b.lat0 + b.lat1) / 2);
            ctx.fillText(cl[i].name, x, ci >= 0 ? y - 10 : y);
          }
        }
      }

      const mode = cfg(this, "dots") || "both";
      this._pts = [];
      if (mode !== "none" && this._d.points) {
        const p = this._d.points, { d, stride } = p;
        const brand = cfg(this, "brand") || "";
        const want = brand ? this._netIdx.get(brand) : -2;
        // five times the sites with Level 2 in: smaller dots, or the country is one blot
        const r = ci >= 0 ? 4.2 : focus ? 3.1 : d.length / stride > 30000 ? 1.15 : 1.7;
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
            ctx.globalAlpha = (fi >= 0 && si !== fi) || (ci >= 0 && d[i + 6] !== ci) ? 0.3 : 1;
            ctx.beginPath();
            ctx.arc(x, y, r, 0, 6.2832);
            ctx.fill();
            // zoomed in there are few enough to give each a rim, which keeps
            // neighbours apart where a city stacks them
            // the point's own index rides along, so a click can say which site it was
            if (focus) { ctx.stroke(); if (si === fi) this._pts.push(x, y, d[i + 2], d[i + 3], d[i + 5], i / stride); }
          }
          ctx.globalAlpha = 1;
        };
        ctx.strokeStyle = pal.line; ctx.lineWidth = 0.9;
        if (mode !== "unmapped") { ctx.fillStyle = pal.on; pass(true); }
        if (mode !== "mapped") { ctx.fillStyle = cfg(this, "accent") || pal.off; pass(false); }
      }

      if (flag(cfg(this, "labels")) && !focus) {
        ctx.font = "700 9.5px Overpass, system-ui, sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        for (const [code, st] of Object.entries(outline)) {
          const key = regionOf(code);
          if (!key || !proj[key]) continue;
          const b = ringBounds(st, code);
          const [x, y] = proj[key]((b.lon0 + b.lon1) / 2, (b.lat0 + b.lat1) / 2);
          const a = agg[code];
          const done = !!a && a.sites > 0 && a.mapped === a.sites;
          // the tick is drawn, not typed: no font is relied on to have one
          ctx.fillStyle = done ? pal.doneInk : pal.label;
          ctx.fillText(code, done ? x - 4 : x, y);
          if (done) {
            const w = ctx.measureText(code).width / 2;
            ctx.strokeStyle = pal.doneInk; ctx.lineWidth = 1.6; ctx.lineCap = "round";
            ctx.beginPath();
            ctx.moveTo(x + w - 2, y); ctx.lineTo(x + w + 0.5, y + 2.5); ctx.lineTo(x + w + 5, y - 3);
            ctx.stroke();
          }
        }
      }

      const unit = { mapped: "% of sites on the map", gap: "sites missing", rate: "ports per 100k people", count: "sites" }[metric] +
        (cl && metric !== "rate" ? ", by county" : "");
      this.dispatchEvent(new CustomEvent("map-range", {
        detail: { lo, hi, unit, metric }, bubbles: true, composed: true,
      }));
    }

    _hover(e) {
      if (!this._d || !this._proj) return;
      const r = this._cv.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const was = [this._hi, this._hiCountyIx];
      this._hiSite = null;
      if (this._focus && this._pts && this._pts.length) {
        let best = -1, bd = 81;
        for (let i = 0; i < this._pts.length; i += 6) {
          const dx = this._pts[i] - mx, dy = this._pts[i + 1] - my, d2 = dx * dx + dy * dy;
          if (d2 < bd) { bd = d2; best = i; }
        }
        if (best >= 0) {
          const net = this._d.points.nets[this._pts[best + 2]];
          const ports = this._pts[best + 3], on = (this._pts[best + 4] & 1) === 1;
          this._hiSite = this._pts[best + 5];
          this._tip.innerHTML = "<b>" + h(net) + "</b> · " + ports + " " + h(this._d.portWord || "DC ports") + "<br>" +
            '<span class="' + (on ? "tip-sub" : "tip-off") + '">' +
            (on ? "On OpenStreetMap · click to open it" : "Missing · click to map it") + "</span>";
          this._place(this._pts[best], this._pts[best + 1]);
          this._cv.style.cursor = "pointer";
          return;
        }
      }
      /* A county of the open state, where the counties are in. Checked with
         the same even-odd rule the board assigns sites by, against the
         counties whose box holds the pointer. */
      this._hiCounty = null; this._hiCountyIx = null;
      if (this._cl) {
        const [lon, lat] = this._unproject(mx, my);
        const i = this._cl.findIndex((c) => lat >= c.b.lat0 && lat <= c.b.lat1 && lon >= c.b.lon0 && lon <= c.b.lon1 &&
          inRingsAt(lon, lat, c.rings));
        if (i >= 0) {
          this._hiCounty = this._cl[i].id; this._hiCountyIx = i; this._hi = this._focus;
          if (was[1] !== i) this._queue();
          const a = this._cagg2?.get(i) || { sites: 0, ports: 0, mapped: 0 };
          const pct = a.sites ? Math.floor((a.mapped / a.sites) * 100) : 0;
          this._tip.innerHTML = "<b>" + h(this._cl[i].name) + "</b> · " +
            a.sites.toLocaleString() + " sites, " + a.ports.toLocaleString() + " ports<br>" +
            (!a.sites ? '<span class="tip-sub">No sites</span>'
              : a.mapped === a.sites ? '<span class="tip-done">All of them are on the map</span>'
              : '<span class="tip-sub">' + pct + "% on the map · </span>" +
                '<span class="tip-off">' + (a.sites - a.mapped).toLocaleString() + " missing</span>");
          this._place(mx, my);
          return;
        }
        if (was[1] != null) this._queue();
      }
      const found = hitState(this._d.outline, this._proj, mx, my);
      if (found !== this._hi) { this._hi = found; this._queue(); }
      if (!found) { this._tip.style.opacity = "0"; return; }
      const st = this._d.states[found] || {};
      const a = (this._agg2 || {})[found] || { sites: 0, ports: 0, mapped: 0 };
      const pct = a.sites ? Math.floor((a.mapped / a.sites) * 100) : 0;
      this._tip.innerHTML = "<b>" + h(st.name || found) + "</b> · " +
        a.sites.toLocaleString() + " sites, " + a.ports.toLocaleString() + " ports<br>" +
        (a.sites && a.mapped === a.sites
          ? '<span class="tip-done">All of them are on the map</span>'
          : '<span class="tip-sub">' + pct + "% on the map · </span>" +
            '<span class="tip-off">' + (a.sites - a.mapped).toLocaleString() + " missing</span>");
      this._place(mx, my);
    }

    /* Screen back to longitude and latitude, for the open state's projection.
       Two probe points are enough: the projection is a scale and an offset on
       each axis, and the latitude axis runs the other way. */
    _unproject(mx, my) {
      const px = this._proj.conus;
      const [x0, y0] = px(-100, 40), [x1, y1] = px(-99, 41);
      return [-100 + (mx - x0) / (x1 - x0), 40 + (my - y0) / (y1 - y0)];
    }

    /* Put the tooltip over the point, but keep all of it inside the map: at the
       east and west coasts a centred label ran off the edge of the card. */
    _place(x, y) {
      const tip = this._tip, half = tip.offsetWidth / 2, W = this.clientWidth;
      tip.style.left = Math.max(half + 4, Math.min(W - half - 4, x)) + "px";
      tip.style.top = y + "px";
      tip.style.opacity = "1";
    }
  }

  if (!customElements.get("us-map")) customElements.define("us-map", UsMap);
})();
