/* edit.js was written against the board's page and borrows a handful of its
   globals. This page is not the board, so it supplies the same names before
   edit.js loads — which lets the charge-point site reuse the editor's sign-in,
   tile map, imagery ranking and changeset upload through window.OSMKit instead
   of carrying a second copy of all of it.

   edit.js binds its own UI to #improve-open, which does not exist here, so its
   interface stays dormant and only the kit is used. */

const $ = (id) => document.getElementById(id);
const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };
const nf = (n) => n.toLocaleString("en-US");
const cssv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

const R = 111320;
const metres = (a, b) => {
  const dy = (a.lat - b.lat) * R;
  const dx = (a.lon - b.lon) * R * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dy, dx);
};

/* Brand marks are the board's. points.js loads the same data/brands.json, so
   this reads the same shape it does — `{brands: {name: {qid, icon}}}` — and
   falls back to a monogram for anything the table has no row for. */
let BRANDS = {};
const MONO_HUES = [210, 24, 158, 42, 280, 340, 190, 100];
function brandMark(name) {
  const src = BRANDS?.brands?.[name]?.icon;
  if (src) return `<img class="bmark" src="${src}" alt="" loading="lazy" decoding="async">`;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = MONO_HUES[h % MONO_HUES.length];
  const letter = name.replace(/[^A-Za-z0-9]/g, "").charAt(0).toUpperCase() || "?";
  return `<span class="bmark mono-mark" style="--h:${hue}">${letter}</span>`;
}

// Referenced by edit.js's own flow, which never runs here.
let MERGED = null;
const VIEW = { state: null, net: null };
const render = () => {};
const DATA_ORIGIN = window.DATA_ORIGIN || "./data";
const DATA_SUFFIX = window.DATA_SUFFIX || "";
