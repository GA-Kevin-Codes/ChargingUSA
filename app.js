/* Live charging board — fetches through the Cloudflare Worker, merges in the browser. */

const DATA_ORIGIN = window.DATA_ORIGIN || "https://charge-board-data.YOUR-SUBDOMAIN.workers.dev";
// Static-file mode: point DATA_ORIGIN at a directory of saved payloads and set
// DATA_SUFFIX to ".json". Lets the board run with no worker deployed.
const DATA_SUFFIX = window.DATA_SUFFIX || "";

const OVERRIDE = new Set(["Tesla", "Electrify America", "IONNA"]);
const LIVE = new Set(["OPEN", "EXPANDING"]);
const CONN = { J1772COMBO: "CCS1", TESLA: "NACS / Tesla", CHADEMO: "CHAdeMO", J1772: "J1772 (AC)" };
const DISPLAY = {
  "eVgo Network": "EVgo", "ChargePoint Network": "ChargePoint", "Blink Network": "Blink",
  RED_E: "Red E", FORD_CHARGE: "Blue Oval", FCN: "Francis Energy", FPLEV: "FPL EVolution",
  RIVIAN_ADVENTURE: "Rivian Adventure", EVGATEWAY: "EV Gateway", SHELL_RECHARGE: "Shell Recharge",
  BP_PULSE: "bp pulse", CIRCLE_K: "Circle K", ELECTRIC_ERA: "Electric Era", "7CHARGE": "7-Eleven",
  CHARGELAB: "ChargeLab", RIVIAN_WAYPOINTS: "Rivian Waypoints", "Non-Networked": "Independent",
};
const disp = (k) => DISPLAY[k] ?? (k.includes("_") ? k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : k);

// ATP spider status per network, as of the 2026-08-01 weekly run. "ok" = producing
// features; "broken" = spider exists but returned zero; absent = no spider written.
const SRC_SHORT = { AFDC: "afdc", "supercharge.info": "sci", "ATP electrify_america_us": "atp", "ATP ionna_us": "atp" };
const SPIDERS = {
  Tesla: ["tesla", "broken"],
  "Electrify America": ["electrify_america_us", "ok"],
  EVgo: ["evgo_us", "broken"],
  ChargePoint: ["chargepoint", "ok"],
  Blink: ["blink", "ok"],
  IONNA: ["ionna_us", "ok"],
  "bp pulse": ["bp", "ok"],
  "Circle K": ["circle_k", "ok"],
  FLO: ["flo_ca_us", "ok"],
  "Shell Recharge": ["shell_recharge", "ok"],
};

// Retail hosts, matched on AFDC station names. Only ~9% of records name their
// host, so every figure here is a floor, not a census.
const HOSTS = [
  ["Walmart", /wal-?mart/i], ["Pilot / Flying J", /pilot|flying j/i], ["Target", /\btarget\b/i],
  ["Wawa", /wawa/i], ["Meijer", /meijer/i], ["Kroger", /kroger/i], ["Buc-ee's", /buc-?ee/i],
  ["Love's", /love'?s/i], ["Sheetz", /sheetz/i], ["Casey's", /casey'?s/i], ["Costco", /costco/i],
  ["Royal Farms", /royal farms/i], ["IKEA", /\bikea\b/i], ["Whole Foods", /whole foods/i],
  ["Sam's Club", /sam'?s club/i], ["Home Depot", /home depot/i], ["Hy-Vee", /hy-?vee/i],
];
const hostOf = (name) => {
  if (!name) return null;
  for (const [label, re] of HOSTS) if (re.test(name)) return label;
  return null;
};

/* Brand marks. Icons are baked into data/brands.json as data URIs at build time
   rather than hotlinked, so the page makes no third-party requests and nothing
   breaks when a brand reshuffles its assets. Networks whose sites block
   automated fetches (Tesla, EVgo, Ford) fall back to a monogram. */
let BRANDS = {};
const MONO_HUES = [210, 24, 158, 42, 280, 340, 190, 100];
function brandMark(name) {
  const src = BRANDS[name];
  if (src) {
    return `<img class="bmark" src="${src}" alt="" loading="lazy" decoding="async">`;
  }
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = MONO_HUES[h % MONO_HUES.length];
  const letter = name.replace(/[^A-Za-z0-9]/g, "").charAt(0).toUpperCase() || "?";
  return `<span class="bmark mono-mark" style="--h:${hue}">${letter}</span>`;
}

/* Access filtering. Each source marks restriction differently, and none of the
   "public" flags is sufficient on its own:
     AFDC   access_code=public still includes gated and key-only sites; they are
            marked restricted_access, with access_detail_code giving the reason.
     ATP EA COMMERCIAL sites become access=customers — patrons of the host only.
     supercharge.info has no flag; a handful say so in free-text access notes.
   Excluded sites are counted and reported, never dropped silently. */
const AFDC_BLOCKED_DETAIL = new Set(["KEY_ALWAYS"]);
// A handful of AFDC records declare in their own name that they are not usable
// — "NOT A PUBLIC SITE", "Private DCFC", "Test Site" — while still carrying
// access_code=public. Believe the name.
const NOT_PUBLIC_NAME = /\b(not a public|not public|private dcfc|test site|demo only)\b/i;
const RESTRICTED_TEXT = /\b(permit holders?|private|residents? only|employees? only|tenants? only|badge)\b/i;

/* Supercharger for Business: Tesla hardware bought and run by a host business.
   supercharge.info flags these by prefixing the site name with the owner in
   square brackets — "[Francis Energy] Durant, OK". Tesla neither operates nor
   bills them, so attributing them to Tesla overstates its network and, where
   the owner is itself an AFDC network, counts the same site twice. Attribute to
   the owner, and drop any that AFDC already carries under another operator. */
const BUSINESS_PREFIX = /^\s*\[([^\]]+)\]\s*/;
const BUSINESS_LABEL = "Supercharger for Business";
// Re-attribute to the owner only where that owner already runs a network of its
// own; otherwise a one-site host would become a "network", which is noise.
function businessOwner(name, knownNetworks) {
  const m = BUSINESS_PREFIX.exec(name || "");
  if (!m) return null;
  const raw = m[1].trim();
  if (raw === "TBD") return BUSINESS_LABEL;
  return knownNetworks.has(raw) ? raw : BUSINESS_LABEL;
}

/* View state. The merge runs once; selecting a state only changes what render
   draws, so switching states is instant and totals stay consistent. */
const VIEW = { state: null, net: null, selected: null, metric: "pop", zoom: 1, pan: { x: 0, y: 0 }, stack: [], stackAt: 0,
               // recently-opened panel: a preset in days, or an explicit range
               // still read by the editor's own "opened within" filter
               impOpen: null,
               // how the per-state coverage list is ordered
               stateOrder: "pct",
               // the atlas: which figure shades the states, which sites show as
               // dots, and the rail's filter box
               mapMetric: "mapped", dots: "both", query: "", stateQuery: "" };
let MERGED = null;

const CONUS = { lat0: 24, lat1: 50, lon0: -125, lon1: -66 };

/* Surface runtime errors on the page. A thrown error used to abort the rest of
   render(), so one broken panel silently took out everything after it. */
const FAILED = [];
function safe(label, fn) {
  try { fn(); } catch (e) {
    FAILED.push(`${label}: ${e.message}`);
    console.error(`[board] ${label} failed`, e);
  }
}
window.addEventListener("error", (e) => {
  const s = document.getElementById("status");
  if (s) s.innerHTML = `<span class="chip" style="color:var(--s2)">script error</span> ${e.message}`;
});

const nf = (n) => n.toLocaleString("en-US");
const $ = (id) => document.getElementById(id);
const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };
/* Station names come from AFDC and are whatever an operator typed — "Bob & Sons"
   turns up often enough, and an unescaped ampersand in a template is a broken
   row at best. */
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const cssv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/* ------------------------------------------------------------------- geometry */

const R = 111320;
const metres = (a, b) => {
  const dy = (a.lat - b.lat) * R;
  const dx = (a.lon - b.lon) * R * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dy, dx);
};

/** Collapse rows of one network sitting within `m` metres, or sharing a street address. */
function collapse(rows, m = 80) {
  const parent = rows.map((_, i) => i);
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };

  const cell = (m / R) * 1.5;
  const grid = new Map();
  rows.forEach((r, i) => {
    const k = `${Math.floor(r.lat / cell)},${Math.floor(r.lon / cell)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
  for (const [key, idxs] of grid) {
    const [gy, gx] = key.split(",").map(Number);
    const near = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) near.push(...(grid.get(`${gy + dy},${gx + dx}`) || []));
    for (const i of idxs) for (const j of near) if (j > i && metres(rows[i], rows[j]) <= m) union(i, j);
  }
  const byAddr = new Map();
  rows.forEach((r, i) => {
    if (!r.street) return;
    const k = `${r.street.toLowerCase().replace(/[.,#]/g, " ").replace(/\s+/g, " ").trim()}|${(r.city || "").toLowerCase()}|${r.state}`;
    if (!byAddr.has(k)) byAddr.set(k, []);
    byAddr.get(k).push(i);
  });
  for (const idxs of byAddr.values()) for (let n = 1; n < idxs.length; n++) union(idxs[0], idxs[n]);

  const groups = new Map();
  rows.forEach((r, i) => {
    const k = find(i);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  });
  return [...groups.values()];
}

/* Is this site the one already on the map?

   A plain distance between two points is not enough, because the two things
   being compared are not both points. A network publishes one coordinate — a
   pylon, an entrance, the middle of a forecourt — while OSM may hold the site
   as an area covering the whole lot. Lost Hills is the extreme: 168 stalls
   under solar canopy, mapped as a multipolygon whose centre lands 234 m from
   Tesla's own coordinate, with that coordinate sitting *inside* the polygon.
   At a flat 150 m it read as unmapped, and being the largest site in the
   country it went straight to the top of the contribution queue.

   Two allowances, then:
     ext    how far the OSM element itself reaches, from its bounding box, so a
            big area is matched against its edge rather than its middle.
     brand  the same operator within 600 m is the same site. Two Superchargers
            do not get built 600 m apart; that distance is an offset between
            sources, not a second site. Measured against the current data, this
            reclaims 111 sites (1.5% of the unmapped list), and every one
            inspected was the same site logged twice. Past ~600 m genuine
            neighbours start appearing — two Las Vegas Superchargers 896 m
            apart — so it stops there. */
/* A fourth allowance, and the only one that is not a distance: an OSM element
   carrying `ref:afdc` names the record it answers, so where the board holds
   that id the two are the same site by declaration and nothing has to be
   inferred from where the coordinates landed.

   `OSM_REF_SANITY` is not a matching radius. Measured against every US element
   carrying the tag — 2,113 id pairs the board can resolve — the median gap is
   7 m and the 99th percentile 132 m; twelve sit past 150 m and two past 300 m,
   all of them plainly the same site. One is 8,994 km out, an id copied onto the
   wrong continent. So the bound is set where nothing genuine lives and that one
   sits well outside it: past 2 km the id is disbelieved and the distance rules
   below decide, exactly as they did before. */
const OSM_NEAR = 150;
const OSM_BRAND_NEAR = 600;
const OSM_REF_SANITY = 2000;
const OSM_SCAN = 1400;                 // grid cell, ≥ the widest rule above
const BRAND_NOISE = /\b(supercharger|superchargers|charging|chargers?|stations?|network|networks|company|inc|llc|ltd|the)\b/g;
const brandKey = (b) => (b || "").toLowerCase().replace(BRAND_NOISE, "").replace(/[^a-z0-9]/g, "");
function sameBrand(a, b) {
  const x = brandKey(a), y = brandKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // containment catches "Tesla" against "Tesla, Inc.", but only once there is
  // enough of a name to be sure — "ev" would otherwise match half the industry
  return x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x));
}
/* Two different networks in one car park are two sites, not one.

   Proximity alone used to decide this, and brand agreement only ever widened
   the radius — so any charging station within 150 m answered for a lead,
   whatever ran it. That is wrong wherever networks share a lot, which is most
   retail parks: measured against the current data it claimed 427 sites as
   mapped by matching them to somebody else's hardware, and about 280 of those
   were matched to a Tesla Supercharger, Tesla being both the most-mapped
   network in OSM and the one most often built alongside a rival.

   A disagreement only counts as evidence when both names are recognisable
   charging networks. AFDC writes "Independent" for unbranded sites, and OSM
   mappers routinely put the host on `brand` — a Nissan dealership, a city —
   so "Independent ≠ ChargePoint" and "EVgo ≠ Nissan" say nothing about whether
   the two are the same place, and those fall back to distance as before.

   An element naming the record in `ref:afdc` is untouched by any of this: a
   declaration outranks an inference, and that path never reaches here. */
function rivalNetwork(siteNet, osmBrand, nets) {
  if (!nets) return false;
  const a = brandKey(siteNet), b = brandKey(osmBrand);
  if (!nets.has(a) || !nets.has(b)) return false;
  return !sameBrand(siteNet, osmBrand);
}

/* Names a network register uses for "no network", which are not brands. */
const NET_PLACEHOLDER = new Set(["independent", "nonnetworked", "unknown", "other", "none"]
  .map((n) => brandKey(n)));

/* The vocabulary of things that really are charging networks, taken from the
   board's own leads rather than a list somebody has to maintain. */
function networkVocabulary(sites) {
  const out = new Set();
  for (const s of sites) {
    const k = brandKey(s.net);
    if (k.length >= 4 && !NET_PLACEHOLDER.has(k)) out.add(k);
  }
  return out;
}

const osmMatchWith = (nets) => (site, o, d) =>
  (d <= OSM_NEAR + (o.ext || 0) && !rivalNetwork(site.net, o.brand, nets)) ||
  (d <= OSM_BRAND_NEAR && sameBrand(site.net, o.brand));

/* One index over a list of OSM elements: the grid the distance rules walk, and
   the ids for those elements that name an AFDC record.

   The id side is many-to-many in both directions — a mapper who has recorded
   several ids on one element lists them semicolon-separated, and eighteen ids
   nationally are claimed by more than one element — so it collects rather than
   overwrites, and leaves the choosing to `bestMatch`. */
/* The record ids an element names, namespaced by which register they belong to.
   Two sources publish an id OSM has a tag for and they number independently, so
   AFDC 39727 and supercharge.info 39727 are different places and must never
   collide in one index. */
const osmIds = (o) => [
  ...(o.afdc ? String(o.afdc).split(";").map((r) => `afdc:${r.trim()}`) : []),
  ...(o.sc ? String(o.sc).split(";").map((r) => `sc:${r.trim()}`) : []),
].filter((k) => k.length > 5);

/* The same, for a site the board holds. `refs` is AFDC's numbering whichever
   source the site itself came from — see the reunion below. */
const siteIds = (s) => [
  ...(s.refs || []).map((r) => `afdc:${r}`),
  ...(s.sc ? [`sc:${s.sc}`] : []),
];

function indexOsm(list) {
  const cell = OSM_SCAN / R;
  const grid = new Map();
  const byRef = new Map();
  for (const o of list) {
    const k = `${Math.floor(o.lat / cell)},${Math.floor(o.lon / cell)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(o);
    for (const id of osmIds(o)) {
      if (!byRef.has(id)) byRef.set(id, []);
      byRef.get(id).push(o);
    }
  }
  return { cell, grid, byRef };
}

/* The one element that best answers for this site, or null. `near` is the
   caller's distance rule; an id is accepted whatever the distance says, subject
   only to the sanity bound above.

   One rule, three tiers. An id beats a distance, because it is a claim somebody
   made rather than one this code inferred; then socket detail, because that is
   a tier the board reports; then nearness. */
function bestMatch(s, ix, near) {
  let hit = null, at = Infinity, byRef = false;
  const consider = (o, d, id) => {
    if (!hit || (id && !byRef) ||
        (id === byRef && ((o.dc && !hit.dc) || (o.dc === hit.dc && d < at)))) {
      hit = o; at = d; byRef = id;
    }
  };
  for (const r of siteIds(s))
    for (const o of ix.byRef.get(r) || []) {
      const d = metres(s, o);
      if (d <= OSM_REF_SANITY) consider(o, d, true);
    }
  const gy = Math.floor(s.lat / ix.cell), gx = Math.floor(s.lon / ix.cell);
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++)
      for (const o of ix.grid.get(`${gy + dy},${gx + dx}`) || []) {
        const d = metres(s, o);
        if (!near(s, o, d)) continue;
        consider(o, d, false);
      }
  return hit && { el: hit, at, byRef };
}

/* Add up unit kinds from several AFDC records describing one site. Same kind
   from two records is one kind with the counts added — otherwise a site
   collapsed from three records reads as three descriptions of the same
   pedestal. */
function mergeUnits(rows) {
  const by = new Map();
  for (const u of rows) {
    const key = `${u.kw ?? ""}|${Object.entries(u.conn).sort().map(([k, v]) => `${k}:${v}`).join(",")}`;
    const hit = by.get(key);
    if (hit) hit.n += u.n;
    else by.set(key, { ...u });
  }
  return [...by.values()].sort((a, b) => b.n - a.n);
}

/* ---------------------------------------------------------------------- merge */

function merge(afdc, tesla, ea, ionna, osm) {
  const sites = [];
  let afdcRecords = afdc.sites.length, afdcSites = 0, cpRecords = 0, cpSites = 0;

  const excluded = { afdc: 0, ea: 0, tesla: 0 };
  const overridden = [];               // AFDC ids for networks a better source supplies
  const byNet = new Map();
  for (const s of afdc.sites) {
    if (s.restricted || AFDC_BLOCKED_DETAIL.has(s.accessDetail) || NOT_PUBLIC_NAME.test(s.name || "")) {
      excluded.afdc++; continue;
    }
    if (!byNet.has(s.net)) byNet.set(s.net, []);
    byNet.get(s.net).push(s);
  }
  for (const [net, rows] of byNet) {
    const groups = collapse(rows);
    afdcSites += groups.length;
    if (net === "ChargePoint Network") { cpRecords = rows.length; cpSites = groups.length; }
    if (OVERRIDE.has(net)) {
      /* Set aside rather than dropped. A better source replaces these three
         networks, but only AFDC publishes an id OSM has a tag for, and
         discarding the record threw that id away with it. Reunited below. */
      for (const g of groups) {
        const base = g.reduce((a, b) => (b.ports > a.ports ? b : a));
        /* The id was never the only thing worth keeping. AFDC also publishes
           the connector breakdown, the open date and a street address, and the
           source that replaces this record publishes none of them — so a
           Electrify America site used to arrive with no socket detail, no open
           date, and therefore no place in the openings queue at all. Set the
           lot aside and let the reunion fill whatever the better source left
           blank. */
        overridden.push({ net: disp(net), lat: base.lat, lon: base.lon,
          refs: [...new Set(g.map((x) => x.id).filter((id) => id != null))].sort((a, b) => a - b),
          units: mergeUnits(g.flatMap((x) => x.units || [])),
          open: g.map((x) => x.open).filter(Boolean).sort()[0] || null,
          conf: g.map((x) => x.conf).filter(Boolean).sort().pop() || null,
          city: base.city || null, street: base.street || null, fac: base.fac || null,
          afdcPorts: g.reduce((a, b) => a + (b.ports || 0), 0) || null });
      }
      continue;
    }
    for (const g of groups) {
      const base = g.reduce((a, b) => (b.ports > a.ports ? b : a));
      sites.push({
        net: disp(net), name: base.name, lat: base.lat, lon: base.lon, state: base.state,
        // the street address AFDC publishes, kept for the export: a coordinate
        // in a car park is easier to find when something names the road
        city: base.city || null, street: base.street || null,
        ports: g.reduce((a, b) => a + (b.ports || 0), 0) || 1,
        open: g.map((x) => x.open).filter(Boolean).sort()[0] || null,
        conf: g.map((x) => x.conf).filter(Boolean).sort().pop() || null,
        fac: base.fac, src: "AFDC",
        /* AFDC's own station ids, carried through so the editor can stamp
           `ref:afdc` on what it creates — the one identifier any of these
           sources publishes that OSM already has a tag for. A list, not an id:
           16% of these sites are several AFDC records collapsed into one, and
           every one of them describes this site. */
        refs: [...new Set(g.map((x) => x.id).filter((id) => id != null))].sort((a, b) => a - b),
        /* AFDC's per-unit breakdown, summed across the records this site was
           collapsed from. It says how many physical units stand here and what
           each one is — the counts behind an accurate `capacity`, and the
           number of charge points there are to place. */
        units: mergeUnits(g.flatMap((x) => x.units || [])),
        conn: [...new Set(g.flatMap((x) => (x.conn || []).map((c) => CONN[c]).filter(Boolean)))],
      });
    }
  }

  const knownNetworks = new Set(sites.map((s) => s.net));
  const pipeline = [];
  for (const s of tesla.sites) {
    if (!LIVE.has(s.status)) { pipeline.push({ status: s.status, state: s.state }); continue; }
    if (s.notes && RESTRICTED_TEXT.test(s.notes)) { excluded.tesla++; continue; }
    const conn = new Set();
    for (const [k, v] of Object.entries(s.plugs || {})) {
      if (!v) continue;
      if (k === "nacs" || k === "tpc") conn.add("NACS / Tesla");
      else if (k === "ccs1") conn.add("CCS1");
    }
    const owner = businessOwner(s.name, knownNetworks);
    // supercharge.info counts stalls carrying each plug type. They overlap by
    // design — a Magic Dock stall offers both — so these are per-connector
    // counts, not a partition of the stalls, which is what socket:* means.
    const sockets = {};
    for (const [k, v] of Object.entries(s.plugs || {})) {
      if (!v || k === "multi") continue;
      const key = k === "tpc" || k === "nacs" ? "nacs" : k === "ccs1" ? "type1_combo" : k === "chademo" ? "chademo" : null;
      if (key) sockets[key] = Math.max(sockets[key] || 0, v);
    }
    sites.push({
      net: owner || "Tesla", name: s.name, lat: s.lat, lon: s.lon, state: s.state,
      ports: s.ports || 1, open: s.open, conf: null, fac: null,
      src: "supercharge.info", conn: [...conn], sockets,
      // supercharge.info's site id. `ref:supercharge_info` is on 2,929 US
      // elements, so this is a published identifier OSM already keeps, exactly
      // as `refs` is for AFDC.
      sc: s.id,
      business: !!BUSINESS_PREFIX.test(s.name || ""),
    });
  }

  // All the Places publishes EA as one feature per charger, so the site's
  // connector mix can be counted rather than guessed: each point carries its own
  // socket, and summing them by type gives the real per-connector totals.
  const units = new Map();
  const eaSockets = new Map();
  for (const p of ea.sites) {
    if (p.kind !== "point") continue;
    const base = String(p.ref).includes("-") ? String(p.ref).replace(/-[^-]*$/, "") : String(p.ref);
    const dc = p.sockets.type1_combo || p.sockets.chademo || p.sockets.nacs;
    if (dc) units.set(base, (units.get(base) || 0) + 1);
    if (!eaSockets.has(base)) eaSockets.set(base, {});
    const tally = eaSockets.get(base);
    for (const [k, v] of Object.entries(p.sockets)) tally[k] = (tally[k] || 0) + (Number(v) || 1);
  }
  for (const p of ea.sites) {
    if (p.kind !== "site") continue;
    if (p.access && p.access !== "public") { excluded.ea++; continue; }
    sites.push({ net: "Electrify America", name: p.name, lat: p.lat, lon: p.lon, state: p.state,
      ports: units.get(String(p.ref)) || 1, open: null, conf: null, fac: null,
      src: "ATP electrify_america_us", conn: ["CCS1"], sockets: eaSockets.get(String(p.ref)) || {} });
  }

  for (const p of ionna.sites) {
    const conn = [];
    if (p.sockets.nacs) conn.push("NACS / Tesla");
    if (p.sockets.type1_combo) conn.push("CCS1");
    sites.push({ net: "IONNA", name: p.name, lat: p.lat, lon: p.lon, state: p.state,
      ports: p.capacity || 1, open: null, conf: null, fac: null, src: "ATP ionna_us",
      conn, sockets: p.sockets || {} });
  }

  // A business Supercharger that AFDC already lists under its operating network
  // is the same physical site reported twice. Keep the AFDC record and drop ours.
  let businessDeduped = 0;
  const afdcCell = (200 / R) * 2;
  const afdcGrid = new Map();
  for (const a of sites) {
    if (a.src !== "AFDC") continue;
    const k = `${Math.floor(a.lat / afdcCell)},${Math.floor(a.lon / afdcCell)}`;
    if (!afdcGrid.has(k)) afdcGrid.set(k, []);
    afdcGrid.get(k).push(a);
  }
  const kept = [];
  for (const s of sites) {
    if (s.business) {
      const gy = Math.floor(s.lat / afdcCell), gx = Math.floor(s.lon / afdcCell);
      let clash = false;
      for (let dy = -1; dy <= 1 && !clash; dy++)
        for (let dx = -1; dx <= 1 && !clash; dx++)
          for (const a of afdcGrid.get(`${gy + dy},${gx + dx}`) || [])
            if (metres(s, a) <= 200) { clash = true; break; }
      if (clash) { businessDeduped++; continue; }
    }
    kept.push(s);
  }
  sites.length = 0;
  sites.push(...kept);

  /* Give the three overridden networks their AFDC ids back.

     Tesla, Electrify America and IONNA are taken from supercharge.info and All
     the Places, which are better on stalls and status. AFDC lists the same
     places under its own numbering, and that numbering is the one OSM has a tag
     for — so the record is looked up here and its ids attached to whichever
     site replaced it.

     Same network and within the operator radius, because that is the same claim
     the OSM matcher makes with those two facts: two sources naming one operator
     at one place. Deliberately unwilling to guess — a group with no site of its
     own network nearby keeps its ids to itself, since a wrong one would be
     written into OSM as somebody else's `ref:afdc`. */
  const siteIx = indexOsm(sites);
  let reunited = 0;
  for (const g of overridden) {
    const gy = Math.floor(g.lat / siteIx.cell), gx = Math.floor(g.lon / siteIx.cell);
    let hit = null, at = Infinity;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        for (const t of siteIx.grid.get(`${gy + dy},${gx + dx}`) || []) {
          if (t.net !== g.net) continue;
          const d = metres(g, t);
          if (d <= OSM_BRAND_NEAR && d < at) { hit = t; at = d; }
        }
    if (!hit) continue;
    hit.refs = [...new Set([...(hit.refs || []), ...g.refs])].sort((a, b) => a - b);
    /* Fill gaps only. All the Places and supercharge.info are here because they
       are better on stalls and status, so `ports` is theirs and stays theirs —
       what AFDC adds is everything they do not carry. Where both have a figure
       the better source wins; where only AFDC has one, having it beats not. */
    if (!hit.units?.length && g.units?.length) hit.units = g.units;
    hit.open ??= g.open;
    hit.conf ??= g.conf;
    hit.city ??= g.city;
    hit.street ??= g.street;
    hit.fac ??= g.fac;
    /* Kept apart from `ports` rather than reconciled with it. The two sources
       count different things — AFDC counts what it was told, ATP counts what
       the operator's own map shows today — and a panel that quietly averaged
       them would be inventing a number neither publishes. The editor shows both
       and says when they disagree. */
    if (g.afdcPorts != null) hit.afdcPorts = g.afdcPorts;
    reunited++;
  }

  /* OSM coverage, three states. On the map at all, and mapped with socket
     detail: most US charging stations carry no socket:* tags, so collapsing
     those two understates how much is actually mapped. And *noted* — nothing
     mapped, but the business hosting the charging says so itself. */
  const stationIx = indexOsm(osm.sites);
  /* Hosts are matched on distance alone. The 600 m operator allowance is for
     two sources naming the same network; what a dealership is branded is the
     marque on its forecourt, which has nothing to do with who runs the charger,
     so applying it here would be matching two unrelated names half a kilometre
     apart. `hosts` is missing from a snapshot taken before the board asked for
     them, which reads as none. */
  const hostIx = indexOsm(osm.hosts || []);
  const hostNear = (s, o, d) => d <= OSM_NEAR + (o.ext || 0);
  const osmMatch = osmMatchWith(networkVocabulary(sites));

  let mapped = 0, detailed = 0, refMatched = 0, noted = 0, hostMapped = 0;
  for (const s of sites) {
    const hit = bestMatch(s, stationIx, osmMatch);
    // Only looked for where no station was found. A site does not become less
    // mapped because the shop beside it also mentions charging.
    const host = hit ? null : bestMatch(s, hostIx, hostNear);
    /* A host that names this record counts as mapped; a host that merely sits
       near one is noted and no more.

       The difference is what the tag says. `charging_station=yes` on its own is
       somebody ticking a box — true, and it could as easily be about the pumps
       across the forecourt. The same tag beside a `ref:afdc` this site is
       actually listed under is a person naming the exact record and saying it
       is accounted for. That is the question the coverage figure asks, and it
       has been answered, even though no amenity=charging_station exists.

       It has to be *this* site's id. Two Superchargers in the last audit were
       carrying a neighbour's `ref:afdc`, so a ref that is merely present proves
       nothing — which is why this reads `byRef` off the id index rather than
       asking whether the element has the tag at all. */
    const claimed = host?.byRef ? host : null;
    /* The element that answered, so a later pass can work on it rather than
       search for it again. `ext` is how far the mapped thing reaches: zero is a
       bare node, which is what the upgrade queue is looking for. */
    const won = hit || claimed;
    s.osmId = won ? won.el.id : null;
    s.osmExt = won ? (won.el.ext || 0) : 0;
    s.osmCap = won ? (won.el.capacity ?? null) : null;
    s.osm = !!hit || !!claimed;
    s.osmDetail = !!(hit || claimed)?.el.dc;
    s.noted = !!host && !claimed;
    // mapped, but by a host rather than a station of its own — kept so the
    // figures can be recounted for whatever slice is on screen, and so the
    // site card can say which of the two it is
    s.hostOnly = !!claimed;
    if (s.osm) mapped++;
    if (s.osmDetail) detailed++;
    if (hit?.byRef || claimed) refMatched++;
    if (claimed) hostMapped++;
    if (s.noted) noted++;
  }

  const business = sites.filter((s) => s.business).length;
  return { sites, pipeline, mapped, detailed, refMatched, noted, hostMapped, reunited, excluded, business, businessDeduped,
           osmTotal: osm.sites.length, osmDc: osm.sites.filter((o) => o.dc).length,
           osmStamp: osm.generated,
           // Every source dates itself differently and refreshes on its own
           // clock — All the Places publishes weekly, so EA and IONNA are never
           // newer than its last run however current everything else is.
           stamps: { OpenStreetMap: osm.generated, AFDC: afdc.generated,
                     "supercharge.info": tesla.generated, "All the Places": ea.run || ionna.run },
           dedupe: { afdcRecords, afdcSites, cpRecords, cpSites } };
}

/* --------------------------------------------------------------------- render */

/* Shared hover tooltip, positioned inside a relatively-placed host. */
/* Count numeric KPIs up on first paint. Anything non-numeric (percentages with
   symbols, ratios) is written straight out. */
function countUp(node, text) {
  node.textContent = text;           // final value first, so it is never blank
  const n = Number(String(text).replace(/[^0-9.]/g, ""));
  if (!isFinite(n) || n < 10 || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const suffix = String(text).replace(/[0-9.,]/g, "");
  const dur = 760, t0 = performance.now();
  const dp = (String(text).split(".")[1] || "").replace(/\D/g, "").length;
  let frames = 0;
  const step = (t) => {
    const k = ++frames > 90 ? 1 : Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - k, 3);
    node.textContent = (n * eased).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }) + suffix;
    if (k < 1) requestAnimationFrame(step);
    else node.textContent = text;
  };
  requestAnimationFrame(step);
}

function bars(hostId, rows, color, labelW, opts = {}) {
  const host = $(hostId);
  host.innerHTML = "";
  const max = Math.max(...rows.map((r) => r[1]), 1);
  for (const [label, val, sub, key] of rows) {
    const r = el("div", "fn-row" + (opts.onPick ? " is-pickable" : "") + (opts.active && key === opts.active ? " is-active" : ""));
    if (opts.onPick && key) {
      r.tabIndex = 0;
      r.setAttribute("role", "button");
      r.addEventListener("click", () => opts.onPick(key));
      r.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); opts.onPick(key); } });
    }
    if (labelW) r.style.gridTemplateColumns = `${labelW} 1fr auto`;
    r.append(el("div", "fn-label", label));
    const track = el("div", "fn-track"), fill = el("div", "fn-fill");
    const pct = `${Math.max(1.2, (val / max) * 100).toFixed(1)}%`;
    fill.style.background = color;
    // width starts at 0 (stylesheet); set it next frame so the transition runs
    requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = pct; }));
    track.append(fill);
    r.append(track, el("div", "fn-val num", nf(val)));
    if (sub) r.title = sub;
    host.append(r);
  }
}

/* Everything the atlas needs, packed from the merge rather than fetched.

   The design's own copy of this map read three files it had generated from a
   snapshot. Ours is handed the live merge: a snapshot would start disagreeing
   with the figures printed beside it the moment anything refreshed, and would
   know nothing of the rival-network match fix or of sites mapped this session.

   The point layer is a flat array on purpose — 13,000 objects re-walked on
   every repaint is what makes a canvas map feel slow. Six numbers per site,
   read by index in board-atlas.js: lat, lon, network, ports, state, flags. */
function atlasData(M) {
  if (!STATES) return null;
  const nets = [...new Set(M.sites.map((s) => s.net))].sort();
  const netIx = new Map(nets.map((n, i) => [n, i]));
  const codes = Object.keys(STATES);
  const stIx = new Map(codes.map((c, i) => [c, i]));

  const stride = 6;
  const rows = M.sites.filter((s) => !s.hostOnly && s.lat != null && s.lon != null);
  const d = new Int32Array(rows.length * stride);
  let at = 0;
  for (const s of rows) {
    d[at] = Math.round(s.lat * 1e4);
    d[at + 1] = Math.round(s.lon * 1e4);
    d[at + 2] = netIx.get(s.net) ?? -1;
    d[at + 3] = s.ports || 0;
    d[at + 4] = stIx.has(s.state) ? stIx.get(s.state) : -1;
    d[at + 5] = s.osm ? 1 : 0;
    at += stride;
  }

  const outline = {}, states = {};
  for (const [code, st] of Object.entries(STATES)) {
    if (st.rings) outline[code] = { rings: st.rings };
    states[code] = { name: st.name, pop: st.pop, sites: 0, ports: 0, mapped: 0 };
  }
  for (const s of rows) {
    const e = states[s.state];
    if (!e) continue;
    e.sites++; e.ports += s.ports || 0; if (s.osm) e.mapped++;
  }
  return { outline, states, points: { nets, states: codes, d, stride } };
}

const METRIC_TITLE = {
  mapped: "Percent of sites on the map",
  gap: "Sites missing from the map",
  rate: "Ports per 100,000 people",
  count: "Sites",
};
const METRIC_SEG = [["mapped", "% mapped"], ["gap", "missing"], ["rate", "per person"], ["count", "sites"]];
const DOTS_SEG = [["both", "both"], ["unmapped", "missing only"], ["mapped", "mapped only"]];

function seg(hostId, options, current, onPick) {
  const host = $(hostId);
  if (!host) return;
  host.innerHTML = options.map(([k, label]) =>
    `<button data-k="${k}" class="${k === current ? "is-on" : ""}" aria-pressed="${k === current}">${esc(label)}</button>`).join("");
  for (const b of host.querySelectorAll("button")) b.onclick = () => onPick(b.dataset.k);
}

function render(M) {
  MERGED = M;
  const Sstate = VIEW.state ? M.sites.filter((s) => s.state === VIEW.state) : M.sites;
  /* The rail stays whole: it is the picker, so filtering it to the current
     network would take away the means of switching or clearing. */
  const S = VIEW.net ? Sstate.filter((s) => s.net === VIEW.net) : Sstate;
  const choroSites = VIEW.net ? M.sites.filter((s) => s.net === VIEW.net) : M.sites;
  if (!Sstate.length) { $("map-sub").textContent = "No sites in that state."; return; }

  const mapped = S.filter((s) => s.osm).length;
  const missing = S.length - mapped;
  const noted = S.filter((s) => s.noted).length;
  const hostMapped = S.filter((s) => s.osm && s.hostOnly).length;
  const detailed = S.filter((s) => s.osmDetail).length;
  M = { ...M, mapped, detailed, noted, hostMapped };
  const ports = S.reduce((a, s) => a + s.ports, 0);

  const nets = new Map();
  for (const s of Sstate) {
    const e = nets.get(s.net) || [0, 0, 0];
    e[0]++; e[1] += s.ports; if (s.osm) e[2]++;
    nets.set(s.net, e);
  }
  const ranked = [...nets].sort((a, b) => b[1][1] - a[1][1]);
  const nationalPorts = M.sites.reduce((a, s) => a + (s.hostOnly ? 0 : s.ports), 0);
  const nationalNets = new Set(M.sites.map((s) => s.net)).size;
  const bigNets = [...M.sites.reduce((m, s) => m.set(s.net, (m.get(s.net) || 0) + s.ports), new Map())]
    .filter(([, p]) => p >= 100).length;

  FAILED.length = 0;

  /* ---- top bar ---- */
  $("prov").innerHTML =
    `<b>${nf(S.length)}</b> sites · <b>${nf(ports)}</b> DC ports · ${esc(shortStamp(M.stamps))}`;
  const stName = VIEW.state ? (STATES?.[VIEW.state]?.name || VIEW.state) : "";
  $("scope-label").textContent = VIEW.net && VIEW.state ? `${VIEW.net} · ${stName}`
    : VIEW.net || (VIEW.state ? stName : "All networks · every state");
  $("scope-clear").hidden = !VIEW.net && !VIEW.state;

  /* ---- the atlas ---- */
  safe("atlas", () => {
    const map = $("atlas");
    if (!map) return;
    if (ATLAS_DIRTY) { window.setAtlasData?.(atlasData(M)); ATLAS_DIRTY = false; }
    map.setAttribute("metric", VIEW.mapMetric);
    map.setAttribute("dots", VIEW.dots);
    map.setAttribute("brand", VIEW.net || "");
    map.setAttribute("focus", VIEW.state || "");
    const wait = $("map-wait");
    if (wait) wait.hidden = !!STATES;
    if (wait && !STATES) wait.textContent = "State outlines did not load — the map cannot draw.";
  });

  $("map-title").textContent = VIEW.state ? stName : METRIC_TITLE[VIEW.mapMetric];
  $("map-sub").textContent = VIEW.state
    ? `${VIEW.net ? VIEW.net + " · " : ""}${nf(S.length)} sites here, ${nf(missing)} of them missing from the map. Every dot is one site — hover for its network.`
    : `${VIEW.net ? VIEW.net + ": " : ""}${nf(S.length)} sites, ${nf(missing)} missing. Shading is the state figure; dots are the sites themselves.`;
  $("map-hint").textContent = VIEW.state
    ? "Click outside the state to zoom back out"
    : "Click a state to zoom into its sites";
  $("legend-mapped").textContent = nf(mapped);
  $("legend-missing").textContent = nf(missing);

  seg("metric-seg", METRIC_SEG, VIEW.mapMetric, (k) => { VIEW.mapMetric = k; render(MERGED); });
  seg("dots-seg", DOTS_SEG, VIEW.dots, (k) => { VIEW.dots = k; render(MERGED); });

  /* ---- rail ---- */
  safe("network rail", () => renderRail(ranked, nets));

  /* ---- figures ---- */
  const pct = (mapped / S.length) * 100;
  const kpis = [
    ["Sites", nf(S.length), VIEW.net || VIEW.state ? "in this slice" : "public DC fast charging", ""],
    ["DC ports", nf(ports), S.length ? `${(ports / S.length).toFixed(1)} per site` : "—", ""],
    ["On the map", `${pct.toFixed(1)}%`, `${nf(mapped)} of ${nf(S.length)}`, ""],
    ["Missing", nf(missing), "no station on OSM", "var(--accent)"],
    VIEW.net
      ? ["Share of US ports", `${((ports / nationalPorts) * 100).toFixed(1)}%`, `of ${nf(nationalPorts)}`, "var(--ink-2)"]
      : ["Networks", nf(nationalNets), `${nf(bigNets)} carry 100+ ports`, "var(--ink-2)"],
  ];
  const kw = $("kpis");
  kw.innerHTML = "";
  for (const [label, value, sub, tone] of kpis) {
    const k = el("div", "ab-kpi");
    const v = el("div", "ab-kpi-val");
    if (tone) v.style.color = tone;
    countUp(v, value);
    k.append(el("div", "ab-kpi-label", label), v, el("div", "ab-kpi-sub", sub));
    kw.append(k);
  }

  /* ---- three columns ---- */
  safe("state rail", () => renderStateCoverage(choroSites));
  safe("work queue", () => renderOpenings(S));
  safe("method", () => renderMethod(M, S));
  safe("export button", paintExport);
  safe("networks table", () => renderNetworks(Sstate, ranked));

  $("view-note").textContent = VIEW.state
    ? `Every figure on this page is for ${stName}.`
    : "";

  const D = M.dedupe;
  $("dedupenote").innerHTML = `<dl class="method-list">${[
    ["Dedupe", `${nf(D.afdcRecords)} AFDC records to ${nf(D.afdcSites)} sites. ChargePoint ${nf(D.cpRecords)} to ${nf(D.cpSites)}; every other network under 2%.`],
    ["OSM match", `${OSM_NEAR} m against ${nf(M.osmTotal)} mapped stations (${nf(M.osmDc)} with socket tags), widened by the size of any mapped area, or ${OSM_BRAND_NEAR} m for a match on the same operator — but never between two different networks, however close they stand. ${nf(M.refMatched)} sites skipped all of that and matched outright on a <span class="mono">ref:afdc</span> or <span class="mono">ref:supercharge_info</span> the mapper had already recorded.`],
    ["On a host", `Some charging is recorded on the business hosting it rather than mapped as a station. Where that business also carries the <span class="mono">ref:afdc</span> this site is listed under, it counts as mapped — ${nf(M.hostMapped)} sites. Where the tag stands alone it is only <i>noted</i>, and ${nf(M.noted)} sites sit there.`],
    ["Excluded", `${nf(M.excluded.afdc)} gated or key-only, ${nf(M.excluded.ea)} customers-only, ${nf(M.excluded.tesla)} permit-only.`],
  ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
  const xn = $("xnote");
  if (xn) xn.innerHTML = "";

  $("status").innerHTML = FAILED.length
    ? `<span class="chip" style="color:var(--s2)">${FAILED.length} failed</span> ${FAILED.join("; ")}`
    : freshness(M.stamps);
}

/* The rail: every network, its share of its own sites already on the map, and
   the filter box the design puts above them. Not `bars()` — this row carries
   the bar underneath the name rather than beside it, so a long operator name
   is not squeezed into a third of the width. */
function renderRail(ranked, nets) {
  const host = $("netrail");
  if (!host) return;
  const q = (VIEW.query || "").trim().toLowerCase();
  const rows = ranked.filter(([n]) => !q || n.toLowerCase().includes(q));
  const all = $("net-all");
  if (all) {
    all.textContent = `All ${nf(ranked.length)}`;
    all.classList.toggle("is-off", !!VIEW.net);
  }
  host.innerHTML = rows.length
    ? rows.map(([n, [c, p, m]]) => {
        const share = c ? Math.round((m / c) * 100) : 0;
        return `<button class="ab-net${n === VIEW.net ? " is-on" : ""}" data-net="${esc(n)}"
                  title="${esc(n)} — ${nf(m)} of ${nf(c)} sites on the map, ${nf(p)} ports">
          <span class="ab-net-name">${brandMark(n)}${esc(n)}</span>
          <span class="ab-net-n num">${nf(p)}</span>
          <span class="ab-net-track"><span class="ab-net-fill" style="width:${share}%"></span></span>
        </button>`;
      }).join("")
    : `<p class="ab-empty">No network matches that.</p>`;
  for (const b of host.querySelectorAll("[data-net]")) {
    b.onclick = () => {
      VIEW.net = VIEW.net === b.dataset.net ? null : b.dataset.net;
      render(MERGED);
    };
  }
}

/* Where the figures come from, as the design's third column states it. */
function renderMethod(M, S) {
  const host = $("method-rows");
  if (!host) return;
  const bySrc = new Map();
  for (const s of S) bySrc.set(s.src, (bySrc.get(s.src) || 0) + 1);
  const rows = [
    ...[...bySrc].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, `${nf(v)} sites`]),
    ["OSM charging stations read", nf(M.osmTotal)],
    ["of those, DC-capable", nf(M.osmDc)],
    ["Matched on a published ref", nf(M.refMatched)],
    ["Noted on a host only", nf(M.noted)],
  ];
  host.innerHTML = rows.map(([k, v]) =>
    `<div class="ab-method-row"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("");
}

/* What the refresh button actually did, said plainly.

   Three different things wear the same button. On the local preview it rebuilds
   the payloads from upstream and can fail. On a deployed board there is nothing
   to rebuild — the scheduled job does that — so all the button can do is
   re-read what has been published, bypassing the browser cache. Both are
   useful; reporting one as the other is not.

   "Already current" is a real answer, not a non-answer: it tells you the copy
   you are looking at is the newest one published, which is exactly what someone
   clicks refresh to find out. */
function reportRefresh(rebuild, before, merged) {
  const status = $("status");
  if (!status) return;
  if (rebuild.local && rebuild.ok === false) {
    status.innerHTML =
      `<span class="chip" style="color:var(--s2)">not refreshed</span> ` +
      `${esc(rebuild.note || "the rebuild failed")} — the figures are the previous snapshot.`;
    return;
  }
  if (rebuild.local) return;                    // the freshness line says the rest
  /* Now that we know there is nothing to rebuild here, stop the button
     promising it. Set once we have the answer rather than guessed at load. */
  const btn = $("refresh");
  if (btn) btn.title = "Check for newly published data";
  const changed = before && before !== JSON.stringify(merged.stamps);
  status.innerHTML = changed
    ? `<span class="chip" style="color:var(--s3)">updated</span> ${freshness(merged.stamps)}`
    : `<span class="chip">already current</span> ${freshness(merged.stamps)}`;
}

/* The status dot used to be green whatever had happened, which was untrue in
   two directions at once: reading saved payloads off disk is not a live fetch,
   and even a live fetch returns whatever Overpass last built, which can be
   hours or days back. So the dot follows the age of the data, and the label
   says where it came from — DATA_SUFFIX is the tell, since only the static-file
   mode sets it. A pulse is reserved for data that is actually current. */
const HOUR = 36e5;

/* The top bar's third clause — "fetched 26 Aug". The full freshness line still
   runs in the status slot; this is the one-glance version beside the totals. */
function shortStamp(stamps) {
  // `stamps` is {source: when}, the same shape freshness() reads — the newest
  // of them is what the bar reports
  const at = Object.values(stamps || {}).map(parseStamp).filter(isFinite).sort().pop();
  if (!at) return "no timestamp";
  return "fetched " + new Date(at).toLocaleDateString("en-US", { day: "numeric", month: "short" });
}

function ago(ms) {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / 6e4))} min old`;
  if (ms < 48 * HOUR) return `${Math.round(ms / HOUR)} h old`;
  return `${Math.round(ms / (24 * HOUR))} days old`;
}
/* Sources date themselves in three different ways: an Overpass base timestamp,
   a plain date, and an All the Places run id like 2026-08-08-13-32-19. */
function parseStamp(v) {
  if (!v) return NaN;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:-(\d{2})-(\d{2})-(\d{2}))?$/.exec(String(v));
  return m
    ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4] || "00"}:${m[5] || "00"}:${m[6] || "00"}Z`)
    : Date.parse(String(v));
}
/* The board is only as current as its stalest input, so that is the number on
   the front. The breakdown is one hover away, because "7 days" reads as neglect
   until you know it is All the Places keeping to its weekly run. */
function freshness(stamps) {
  const dated = Object.entries(stamps || {})
    .map(([name, v]) => [name, parseStamp(v), v])
    .filter(([, at]) => isFinite(at))
    .sort((a, b) => a[1] - b[1]);
  const age = dated.length ? Math.max(0, Date.now() - dated[0][1]) : null;
  const live = !DATA_SUFFIX;
  const stale = age == null || age > 24 * HOUR;
  const title = dated.length
    ? dated.map(([name, , raw]) => `${name}: ${String(raw).slice(0, 16).replace("T", " ")}`).join(" · ")
    : "No timestamp from any source";
  return (
    `<span class="${stale || !live ? "stale" : "pulse"}" title="${title}"></span>` +
    // "up to" because this is the stalest of several, not the age of the lot
    `<span title="${title}">${live ? "live fetch" : "saved snapshot"}` +
    `${age == null ? "" : ` · ${dated.length > 1 ? "up to " : ""}${ago(age)}`}</span>`
  );
}

/* Click-to-sort for any table rendered here. Numeric columns are read from the
   cell's data-v attribute so "1,234" and "22%" sort as numbers, not strings. */
function makeSortable(tableId, defaultCol = 2) {
  const table = document.getElementById(tableId)?.closest("table");
  if (!table || table.dataset.sortable) return;
  table.dataset.sortable = "1";
  const heads = [...table.tHead.rows[0].cells];
  const body = table.tBodies[0];
  let active = defaultCol, dir = -1;

  const val = (row, i) => {
    const cell = row.cells[i];
    const raw = cell.dataset.v;
    if (raw !== undefined) return parseFloat(raw);
    const t = cell.textContent.trim();
    const n = parseFloat(t.replace(/[^0-9.-]/g, ""));
    return Number.isNaN(n) ? t.toLowerCase() : n;
  };

  const paint = () => heads.forEach((h, i) => {
    h.setAttribute("aria-sort", i === active ? (dir === 1 ? "ascending" : "descending") : "none");
    const mark = h.querySelector(".sort-mark");
    if (mark) mark.textContent = i === active ? (dir === 1 ? "\u2191" : "\u2193") : "";
  });

  const sort = () => {
    const rows = [...body.rows];
    rows.sort((a, b) => {
      const x = val(a, active), y = val(b, active);
      if (typeof x === "string" || typeof y === "string") return String(x).localeCompare(String(y)) * dir;
      return (x - y) * dir;
    });
    rows.forEach((r) => body.append(r));
    paint();
  };

  heads.forEach((h, i) => {
    h.tabIndex = 0;
    h.style.cursor = "pointer";
    h.setAttribute("role", "columnheader");
    if (!h.querySelector(".sort-mark")) h.insertAdjacentHTML("beforeend", ' <span class="sort-mark"></span>');
    const go = () => {
      if (i === active) dir = -dir;
      else { active = i; dir = i === 0 ? 1 : -1; }
      sort();
    };
    h.addEventListener("click", go);
    h.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  });
  paint();
}

/* AFDC's connector names in OSM's vocabulary. Read by the editor as well as
   the board's own export, so it sits here rather than in either of them.

   The original note: The NEMA sockets are ordinary
   outlets and appear on units AFDC counts as level 1 or 2; they are mapped
   because a site can have both and mistagging them as fast charging would be
   worse than leaving them out. */
const CONN_SOCKET = {
  J1772COMBO: "type1_combo", CHADEMO: "chademo", TESLA: "nacs", J3271: "nacs",
  J1772: "type1", NEMA515: "nema_5_15", NEMA520: "nema_5_20", NEMA1450: "nema_14_50",
};
const DC_SOCKET = new Set(["type1_combo", "chademo", "nacs"]);

/* ------------------------------------------------------------- export

   The unmapped list, as GeoJSON, for working somewhere other than here — JOSM,
   QGIS, a phone in a car park. The board's own editor is better for one site at
   a time; this is for planning a day out, or for handing a state to somebody
   else.

   Every property is a fact from a source, not a suggestion: `name` is what the
   operator calls it, `ref:afdc` is the record it came from. The socket counts
   are AFDC's own, translated into OSM's vocabulary, because a mapper reading
   this file wants `socket:type1_combo`, not `J1772COMBO`. What none of it says
   is where the equipment stands — AFDC publishes one coordinate per site and
   this passes it straight through, so the geometry is a lead, not a survey. */
function missingGeoJSON(sites, scope) {
  const features = sites.map((s) => {
    const sockets = {};
    for (const u of s.units || []) {
      for (const [k, n] of Object.entries(u.conn || {})) {
        const key = CONN_SOCKET[k];
        if (key) sockets[`socket:${key}`] = (sockets[`socket:${key}`] || 0) + n * u.n;
      }
    }
    const kw = Math.max(0, ...(s.units || []).map((u) => u.kw || 0));
    return {
      type: "Feature",
      geometry: { type: "Point", coordinates: [round6(s.lon), round6(s.lat)] },
      properties: {
        name: s.name || null,
        network: s.net,
        ports: s.ports || null,
        state: s.state || null,
        city: s.city || null,
        street: s.street || null,
        opened: s.open || null,
        last_confirmed: s.conf || null,
        source: s.src || null,
        "ref:afdc": (s.refs || []).join(";") || null,
        ...sockets,
        ...(kw ? { "charging_station:output": `${kw} kW` } : {}),
        // a mapper opening this in JOSM wants somewhere to check it against
        osm_search: `https://www.openstreetmap.org/#map=18/${round6(s.lat)}/${round6(s.lon)}`,
      },
    };
  });
  return {
    type: "FeatureCollection",
    // provenance travels with the file: in a month nobody remembers which
    // filter produced it or how old the leads were
    charge_board: {
      generated: new Date().toISOString(),
      scope,
      count: features.length,
      note: "Unmapped DC fast charging sites - leads from the sources named per feature, " +
            "not survey data. Positions are the operator's own and want checking against imagery.",
      sources: "AFDC (US DOE/NLR), supercharge.info, All the Places; matched against OpenStreetMap",
    },
    features,
  };
}

// six decimals is ~10 cm, past which these coordinates are not honest anyway
const round6 = (v) => Math.round(v * 1e6) / 1e6;

const missingHere = () => (MERGED?.sites || []).filter((s) =>
  !s.osm && !s.hostOnly && s.lat != null && s.lon != null &&
  (!VIEW.state || s.state === VIEW.state) && (!VIEW.net || s.net === VIEW.net));

function downloadMissing() {
  const rows = missingHere();
  if (!rows.length) return;

  const scope = [VIEW.state || "US", VIEW.net].filter(Boolean).join(" / ");
  const body = JSON.stringify(missingGeoJSON(rows, scope), null, 1);
  const stamp = new Date().toISOString().slice(0, 10);
  const slug = (v) => String(v).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const name = ["unmapped", VIEW.state ? slug(VIEW.state) : "us",
                VIEW.net ? slug(VIEW.net) : null, stamp].filter(Boolean).join("-") + ".geojson";

  const url = URL.createObjectURL(new Blob([body], { type: "application/geo+json" }));
  const a = el("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  // let the browser start the write before the handle goes
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/* The button says how much it will hand over, because "download" with no number
   is a question rather than an answer. */
function paintExport() {
  const b = $("export-missing");
  if (!b || !MERGED) return;
  const n = missingHere().length;
  b.disabled = !n;
  b.querySelector("span").textContent = n
    ? `${nf(n)} missing${VIEW.state ? ` in ${VIEW.state}` : ""} as GeoJSON`
    : "nothing missing here";
}

/* --------------------------------------------------- coverage by state

   The choropleth answers "where is there charging"; this answers "where is the
   map behind", which is a different question and the one a mapper acts on.

   Ordered by how little of a state is mapped, but a percentage alone ranks a
   state with four sites above one with four hundred, so a floor keeps the list
   about places where the number means something. States under it are still
   reachable through the picker and the map — they are left out of the ranking,
   not out of the board. */
/* The right-hand rail: every state, and how much of it is on the map.

   The mirror of the network rail — same row shape, same click-to-filter, the
   other axis of the same question. Ordered by whichever the toggle says, and
   the two orders answer different things: percent finds the worst-covered
   state, count finds the biggest job. Vermont at 40% of five sites is not the
   work that California at 53% of 2,266 is.

   Every state is listed rather than ranked past a floor, because a rail is
   something you scroll to find a place in, not a leaderboard. What keeps a
   three-site state at 0% from reading as a crisis is the site count beside it
   and the bar going grey below the floor. */
const STATE_MIN_SITES = 12;
const STATE_ORDER = [["pct", "% mapped"], ["gap", "missing"]];

function renderStateCoverage(sites) {
  const host = $("staterail");
  if (!host) return;

  seg("state-order", STATE_ORDER, VIEW.stateOrder, (k) => { VIEW.stateOrder = k; render(MERGED); });

  const agg = new Map();
  for (const s of sites) {
    if (!s.state || s.hostOnly) continue;
    const e = agg.get(s.state) || { n: 0, m: 0, ports: 0, gap: 0 };
    e.n++;
    if (s.osm) e.m++; else { e.gap++; e.ports += s.ports || 0; }
    agg.set(s.state, e);
  }
  const q = (VIEW.stateQuery || "").trim().toLowerCase();
  const rows = [...agg]
    .map(([code, a]) => ({ code, ...a, name: STATES?.[code]?.name || code, pct: (a.m / a.n) * 100 }))
    .filter((r) => !q || r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q))
    .sort((a, b) => VIEW.stateOrder === "gap" ? b.gap - a.gap : a.pct - b.pct || b.n - a.n);

  const note = $("statemap-note");
  if (note) {
    note.textContent = VIEW.stateOrder === "gap"
      ? `Sites with no station on OpenStreetMap. Bar is the share already mapped.`
      : `Least mapped first. Bar and figure are the share already mapped; states under ${STATE_MIN_SITES} sites are greyed, being too small to rank.`;
  }

  host.innerHTML = rows.length
    ? rows.map((r) => `
      <button class="ab-state${r.code === VIEW.state ? " is-on" : ""}${r.n < STATE_MIN_SITES ? " is-thin" : ""}"
              data-state="${r.code}"
              title="${esc(r.name)} — ${nf(r.m)} of ${nf(r.n)} mapped, ${nf(r.gap)} missing, ${nf(r.ports)} ports">
        <span class="ab-state-name"><span class="ab-state-code">${r.code}</span>${esc(r.name)}</span>
        <span class="ab-state-n">${VIEW.stateOrder === "gap" ? nf(r.gap) : Math.round(r.pct) + "%"}</span>
        <span class="ab-state-track"><span class="ab-state-fill" style="width:${r.pct.toFixed(1)}%"></span></span>
      </button>`).join("")
    : `<p class="ab-empty">No state matches that.</p>`;

  for (const b of host.querySelectorAll("[data-state]")) {
    b.onclick = () => {
      const sel = $("state-select");
      sel.value = VIEW.state === b.dataset.state ? "" : b.dataset.state;
      sel.onchange();
    };
  }
}

/* ------------------------------------------------------- recently opened

   AFDC stamps every record with an open date, and the board has been carrying
   it through the merge without ever showing it. It is worth showing: a site
   that opened last month is unmapped 68% of the time against a 47% baseline,
   because nobody has been past it yet. Recency is the best-yield queue here,
   and it needs no source the board does not already pull. */

const dayStart = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/* The window currently asked for, as dates. A preset counts back from today;
   "Today" and "Yesterday" are single days rather than spans, which is what
   somebody checking the morning's openings means by them. */
/* The work queue is the last 30 days — the design fixes it there, and the
   dashboard's own range picker went with the panel it belonged to. What stays
   is the parsing, which is the fiddly part: an AFDC date is a plain date, and
   `new Date("2026-08-24")` is midnight UTC, which is the 23rd everywhere in the
   US. Appending the time keeps it on its own day. */
const OPEN_DAYS = 30;

function openedWithinDays(s, days) {
  if (!s.open) return false;
  const d = new Date(`${String(s.open).slice(0, 10)}T00:00`);
  if (isNaN(d)) return false;
  const cut = dayStart(new Date());
  cut.setDate(cut.getDate() - days);
  return d >= cut;
}

function openWindow() {
  const to = dayStart(new Date());
  const from = new Date(to);
  from.setDate(from.getDate() - OPEN_DAYS);
  return { from, to };
}

function openingsIn(S) {
  const { from, to } = openWindow();
  return S
    .map((s) => ({ s, d: s.open ? dayStart(new Date(`${String(s.open).slice(0, 10)}T00:00`)) : null }))
    .filter(({ d }) => d && !isNaN(d) && (!from || d >= from) && (!to || d <= to))
    .sort((a, b) => b.d - a.d || (b.s.ports || 0) - (a.s.ports || 0));
}

function renderOpenings(S) {
  const host = $("open-rows");
  if (!host) return;
  const rows = openingsIn(S);
  const nat = MERGED.sites.filter((s) => !s.hostOnly);
  const natRecent = nat.filter((s) => openedWithinDays(s, 30));
  const natMapped = natRecent.filter((s) => s.osm).length;

  const note = $("open-note");
  if (note) {
    note.textContent =
      `${nf(rows.length)} of ${nf(natRecent.length)} recent openings` +
      `${VIEW.net || VIEW.state ? " in this slice" : ""} · ` +
      `${nf(natMapped)} of ${nf(natRecent.length)} nationally are already mapped`;
  }

  host.innerHTML = !rows.length
    ? `<p class="ab-empty">Nothing opened in this slice in the last 30 days.
        Clear the network or the state to widen it.</p>`
    : rows.slice(0, 14).map(({ s, d }, i) => `
      <button class="ab-openrow" data-at="${i}"
              title="${s.osm ? `Open ${esc(s.osmId || "it")} on OpenStreetMap` : "Map this site"}">
        <span class="num">${iso(d).slice(5)}</span>
        <span>${esc(s.net)}</span>
        <span class="ab-openrow-name">${esc(s.name || "—")}</span>
        <span class="num">${esc(s.state || "—")}</span>
        <span class="num">${nf(s.ports || 0)} pt</span>
        <span class="${s.osm ? "ab-openrow-on" : "ab-openrow-off"}">${s.osm ? "on map" : "missing"}</span>
      </button>`).join("");

  /* Every row goes somewhere: an unmapped site opens the editor standing on it,
     a mapped one opens what OpenStreetMap already holds. */
  for (const b of host.querySelectorAll("[data-at]")) {
    b.onclick = () => {
      const hit = rows[Number(b.dataset.at)]?.s;
      if (!hit) return;
      if (hit.osm && hit.osmId) {
        const type = { n: "node", w: "way", r: "relation" }[hit.osmId[0]];
        window.open(`https://www.openstreetmap.org/${type}/${hit.osmId.slice(1)}`, "_blank", "noopener");
      } else if (window.ImproveAt) window.ImproveAt(hit);
    };
  }
}

// Display threshold only. Every total, chart and map on this page still counts
// all networks — this trims the table so the long tail of one-site operators
// does not bury the rest.
const TABLE_MIN_PORTS = 100;

function renderNetworks(S, ranked) {
  const body = $("net-rows");
  if (!body) return;
  body.innerHTML = "";
  const stat = new Map();
  for (const s of S) {
    const e = stat.get(s.net) || { n: 0, p: 0, m: 0, src: s.src };
    e.n++; e.p += s.ports; if (s.osm) e.m++;
    stat.set(s.net, e);
  }
  const shown = ranked.filter(([net]) => stat.get(net).p >= TABLE_MIN_PORTS);
  const hidden = ranked.length - shown.length;
  const hiddenPorts = ranked.reduce((a, [net]) => a + (stat.get(net).p < TABLE_MIN_PORTS ? stat.get(net).p : 0), 0);
  const hiddenSites = ranked.reduce((a, [net]) => a + (stat.get(net).p < TABLE_MIN_PORTS ? stat.get(net).n : 0), 0);
  const note = $("net-note");
  if (note) {
    note.textContent =
      `Showing the ${shown.length} networks with ${TABLE_MIN_PORTS}+ DC ports. ` +
      `The other ${hidden} operators (${nf(hiddenSites)} sites, ${nf(hiddenPorts)} ports) are counted in every ` +
      `figure on this page but omitted here.`;
  }
  shown.forEach(([net], i) => {
    const e = stat.get(net);
    const [spider, state] = SPIDERS[net] || [];
    const dot = spider
      ? `<i class="dot" style="background:var(${state === "ok" ? "--s3" : "--s2"})" title="${spider} (${state})"></i>`
      : `<i class="dot dot--none" title="no spider"></i>`;
    const tr = el("tr");
    tr.innerHTML =
      `<td><span class="rank num">${String(i + 1).padStart(2, "0")}</span> ${brandMark(net)}${net}</td>` +
      `<td class="num" data-v="${e.n}">${nf(e.n)}</td>` +
      `<td class="num" data-v="${e.p}">${nf(e.p)}</td>` +
      `<td class="num" data-v="${(e.p / e.n).toFixed(3)}">${(e.p / e.n).toFixed(1)}</td>` +
      `<td class="num" data-v="${(e.m / e.n).toFixed(4)}">${((e.m / e.n) * 100).toFixed(0)}%</td>` +
      `<td style="text-align:right" class="mono">${SRC_SHORT[e.src] || e.src}</td>` +
      `<td style="text-align:center" data-v="${spider ? (state === "ok" ? 2 : 1) : 0}">${dot}</td>`;
    body.append(tr);
  });
  makeSortable("net-rows", 2);
}

/* Choropleth. Sequential single hue, light to dark — a per-capita rate is a
   magnitude, so it gets one ramp, never a categorical set. States with no
   population in OSM (DC, Puerto Rico) render neutral and are labelled as such
   rather than being given a borrowed figure. */
/* Two ways to read the same network. Per person answers "is there charging near
   me"; per EV answers "will I be queuing". They rank almost inversely: the
   states with the most charging per head also have the most cars chasing it. */
const METRICS = {
  pop: {
    title: "Charging per person",
    unit: "per 100k people",
    key: "pop",
    value: (ports, st) => (ports / st.pop) * 1e5,
    fmt: (v) => v.toFixed(1),
    detail: (v, st, ports) => `${v.toFixed(1)} per 100k of ${nf(st.pop)}`,
  },
  count: {
    title: "Stations by state",
    unit: "stations",
    key: null,                       // no denominator, so every state with sites colours
    value: (ports, st, sites) => sites,
    fmt: (v) => nf(Math.round(v)),
    detail: (v, st, ports) => `${nf(Math.round(v))} stations, ${nf(ports)} ports`,
  },
  ev: {
    title: "Charging per electric vehicle",
    unit: "per 1k EVs",
    key: "evs",
    value: (ports, st) => (ports / st.evs) * 1e3,
    fmt: (v) => v.toFixed(0),
    detail: (v, st, ports) => `${v.toFixed(0)} per 1k EVs · ${Math.round(st.evs / ports)} EVs per port`,
  },
};
let STATES = null;
/* Set when a new merge lands. Packing 13,000 sites into a typed array on every
   network click would be work done for nothing — the atlas filters the packed
   layer itself. */
let ATLAS_DIRTY = true;
/* The choropleth, the site map, the state hit-test, the road painter and the
   site detail popover all lived here. The Atlas redesign folds them into one
   subject — <us-map> in board-atlas.js shades the states and draws every site
   as a dot on the same canvas — so ~460 lines of two maps that disagreed about
   what they were showing came out. Their tooltips came with them: the element
   carries its own.  */

/* ----------------------------------------------------------------------- load */

/* `fresh` means the editor asked for it, not the page load. It bypasses the
   browser's own cache and tells the worker to skip its edge copy, so what comes
   back is polled from upstream rather than remembered. */
async function grab(path, fresh) {
  const url = `${DATA_ORIGIN}${path}${DATA_SUFFIX}${fresh ? `?fresh=${Date.now()}` : ""}`;
  const res = await fetch(url, { mode: "cors", cache: fresh ? "reload" : "default" });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

/* Preview mode reads saved files, so there is no upstream for the browser to
   re-poll — the local dev server rebuilds them instead. It reports progress
   while it works, since an OpenStreetMap sweep is minutes, not seconds. Absent
   in any other deployment, where the request simply fails and is ignored. */
async function rebuildSnapshots() {
  // Scoped to the state on screen when there is one: a single Overpass query
  // answers in seconds, where sweeping all 51 takes minutes and asks the editor
  // to wait to find out whether their last upload landed.
  const scope = VIEW.state ? `?state=${VIEW.state}` : "";
  const start = await fetch(`__refresh${scope}`, { method: "POST" }).catch(() => null);
  /* No endpoint means this is not the local preview — the board is on a static
     host, where nothing can be re-polled from the browser. That is a different
     answer from "the rebuild failed", and the button has to say which. */
  if (!start || !start.ok) return { local: false };
  for (let i = 0; i < 600; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const state = await fetch("__refresh").then((r) => r.json()).catch(() => null);
    if (!state) return { local: true, ok: false, note: "the local refresh stopped answering" };
    if (state.note) $("status").innerHTML = `<span class="pulse pulse--wait"></span><span>${state.note}</span>`;
    /* `ok` is the rebuild's own verdict, and it is not the same question as
       whether the job stopped running. A refresh that died on its first line
       used to report success here, the board re-read the files it already had,
       and the only sign anything was wrong was that nothing changed. */
    if (!state.running) return { local: true, ok: state.ok !== false, note: state.note || "" };
  }
  return { local: true, ok: false, note: "the refresh is still running after ten minutes" };
}

async function load(fresh = false) {
  $("status").innerHTML = `<span class="pulse pulse--wait"></span><span>${fresh ? "refreshing" : "loading"}</span>`;
  try {
    // Reported below rather than thrown: stale figures are still worth showing,
    // but not worth showing silently as if they were current.
    const rebuild = fresh ? await rebuildSnapshots() : null;
    const before = MERGED ? JSON.stringify(MERGED.stamps) : null;
    const [afdc, tesla, ea, ionna, osm] = await Promise.all(
      ["/afdc", "/tesla", "/ea", "/ionna", "/osm"].map((p) => grab(p, fresh))
    );
    // Brand marks are optional chrome — never let a miss block the board.
    BRANDS = await grab("/brands").catch(() => ({}));
    STATES = await grab("/states").catch(() => null);
    const merged = merge(afdc, tesla, ea, ionna, osm);
    MERGED = merged;
    ATLAS_DIRTY = true;
    initControls();              // populate the selector first, independent of render
    render(merged);
    if (rebuild) safe("refresh report", () => reportRefresh(rebuild, before, merged));
  } catch (e) {
    $("status").innerHTML = `<span class="chip" style="color:var(--s2)">error</span> ${e.message}`;
    $("dedupenote").innerHTML =
      `<b>Could not load.</b> ${e.message}. Check that <span class="mono">DATA_ORIGIN</span> ` +
      `points at your deployed worker and that the worker has its <span class="mono">OVERPASS_KEY</span> secret set.`;
  }
}

function initControls() {
  const sel = $("state-select");
  const states = [...new Set(MERGED.sites.map((s) => s.state).filter(Boolean))].sort();
  sel.innerHTML = `<option value="">Every state</option>` +
    states.map((st) => `<option value="${st}">${st}</option>`).join("");
  sel.value = VIEW.state || "";
  /* Still the one mechanism. The map's click and the ranked list both set this
     and fire change, so there is a single place that decides what "this state"
     means and a single repaint behind it. */
  sel.onchange = () => {
    VIEW.state = sel.value || null;
    $("reset-view").hidden = !VIEW.state;
    render(MERGED);
  };
  $("reset-view").onclick = () => { sel.value = ""; sel.onchange(); };

  on("scope-clear", "click", () => {
    VIEW.net = null;
    sel.value = "";
    sel.onchange();
  });
  on("net-all", "click", () => { VIEW.net = null; render(MERGED); });
  const q = $("net-query");
  if (q) {
    q.value = VIEW.query || "";
    q.oninput = () => { VIEW.query = q.value; safe("network rail", () => render(MERGED)); };
  }
  const sq = $("state-query");
  if (sq) {
    sq.value = VIEW.stateQuery || "";
    sq.oninput = () => { VIEW.stateQuery = sq.value; safe("state rail", () => render(MERGED)); };
  }

  /* Clicking a state zooms into it; clicking the sea zooms back out. Both go
     through the selector rather than setting VIEW.state directly. */
  const map = $("atlas");
  if (map && !map._wired) {
    map._wired = true;
    map.addEventListener("map-pick", (e) => {
      const code = e.detail.code;
      sel.value = code && code !== VIEW.state ? code : "";
      sel.onchange();
    });
    map.addEventListener("map-range", (e) => {
      const { lo, hi, unit, metric } = e.detail;
      const fmt = (v) => v == null ? "—"
        : metric === "mapped" ? Math.round(v) + "%"
        : metric === "rate" ? v.toFixed(1)
        : nf(Math.round(v));
      $("range-lo").textContent = fmt(lo);
      $("range-hi").textContent = fmt(hi);
      $("range-unit").textContent = unit || "";
    });
  }
}

/* Bind defensively: a control removed from the markup must not take the page
   down at load. */
const on = (id, ev, fn) => { const n = $(id); if (n) n.addEventListener(ev, fn); };
on("export-missing", "click", downloadMissing);
on("refresh", "click", () => {
  const b = $("refresh");
  if (b) { b.classList.add("spin"); b.disabled = true; }
  // Re-poll every source, and in preview mode rebuild the saved payloads first,
  // so this answers "what does OpenStreetMap hold now" and not "what did it
  // hold when the page opened".
  load(true).finally(() => { if (b) { b.classList.remove("spin"); b.disabled = false; } });
});
load();
