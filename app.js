/* Live charging board — fetches through the Cloudflare Worker, merges in the browser. */

const DATA_ORIGIN = window.DATA_ORIGIN || "https://charge-board-data.YOUR-SUBDOMAIN.workers.dev";
// Static-file mode: point DATA_ORIGIN at a directory of saved payloads and set
// DATA_SUFFIX to ".json". Lets the board run with no worker deployed.
const DATA_SUFFIX = window.DATA_SUFFIX || "";

const OVERRIDE = new Set(["Tesla", "Electrify America", "IONNA"]);
const LIVE = new Set(["OPEN", "EXPANDING"]);
const CONN = { J1772COMBO: "CCS1", TESLA: "NACS / Tesla", CHADEMO: "CHAdeMO", J1772: "J1772 (AC)" };
/* Display names, marks and Wikidata ids all come from data/brands.json, which
   is built from the icons folder by tools/build-brands.js. It is one table
   because they are one fact: what this company is called, what its mark looks
   like, and which Wikidata item it is. Keeping the label in a rename map and
   the mark in a separate lookup is how "Chargesmart Ev" ends up printed beside
   the ChargeSmart logo.

   The fallback survives a missing or half-loaded table: shouted, underscored
   feed names are still worth title-casing rather than printing raw. */
const disp = (k) =>
  BRANDS?.nets?.[k] ?? (k.includes("_") ? k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : k);

/* The Wikidata item for a network, for the editor to write as `brand:wikidata`
   without anyone looking it up. Null where the company has no item — four of
   them do not, and inventing one would be worse than leaving the tag off. */
const brandQid = (net) => BRANDS?.brands?.[net]?.qid ?? BRANDS?.brands?.[disp(net)]?.qid ?? null;

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

/* Brand marks. The SVGs ship in icons/ and data/brands.json points at them, so
   they are served from the board's own origin — no third-party requests, and
   nothing breaks when a brand reshuffles its assets. A network with no icon
   falls back to a monogram. */
let BRANDS = {};
const MONO_HUES = [210, 24, 158, 42, 280, 340, 190, 100];
function brandMark(name) {
  const src = BRANDS?.brands?.[name]?.icon;
  if (src) {
    /* brands.json names the `-dark` file wherever one exists — the mark redrawn
       in white for a dark ground. The board has a day side now, so both are
       emitted and the stylesheet shows whichever suits the ground it is on;
       the base file is the same name without the suffix. A mark with only one
       drawing is used on both. */
    const night = /-dark\.svg$/.test(src);
    if (!night) return `<img class="bmark" src="${src}" alt="" loading="lazy" decoding="async">`;
    return `<img class="bmark bmark--day" src="${src.replace(/-dark\.svg$/, ".svg")}" alt="" decoding="async">` +
           `<img class="bmark bmark--night" src="${src}" alt="" decoding="async">`;
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
/* Which `access` values from All the Places mean "not open to the public".

   Named as a deny-list, deliberately. This was an allow-list — anything that
   was not the string "public" was dropped — and when the spider started
   emitting `access=yes` instead (which is the correct OSM value, so a fair
   change on their part) it silently deleted 1,068 of the 1,099 Electrify
   America sites. The board went on reporting confidently on a network that had
   almost entirely vanished from it.

   A deny-list fails the other way: a restriction value nobody has seen before
   would let a private site through. That is the better failure — one wrong site
   in a queue costs a wasted trip, a missing network costs the whole analysis —
   and anything unrecognised is counted and reported rather than waved past. */
const ATP_RESTRICTED = new Set(["customers", "private", "permit", "permissive", "no", "delivery"]);
const ATP_OPEN = new Set(["public", "yes", "designated"]);

const AFDC_BLOCKED_DETAIL = new Set(["KEY_ALWAYS"]);
// A handful of AFDC records declare in their own name that they are not usable
// — "NOT A PUBLIC SITE", "Private DCFC", "Test Site" — while still carrying
// access_code=public. Believe the name.
const NOT_PUBLIC_NAME = /\b(not a public|not public|private dcfc|test site|demo only|for testing purpose)\b/i;
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
               mapMetric: "mapped", dots: "both", query: "", stateQuery: "",
               // which list the panel beside the map shows, where there is only
               // room for one
               browse: "states",
               // Level 2 stations as well as fast charging; off unless asked for
               l2: false,
               // a county inside VIEW.state, by its five-digit FIPS code
               county: null };
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
  if (s) { s.innerHTML = `<span class="chip" style="color:var(--miss)">script error</span>`; s.append(e.message); }
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

/* When are two records one site?

   Only ever within one network — the caller hands this one network's records
   at a time — and then on one of two grounds:

     the same address      number and street, in the same city and state,
                           however each record abbreviates it;
     standing together     within `m` metres, in the same state, AND either
                           naming the same host or giving the same number
                           and street (two records of one building that
                           spell its town differently).

   Position used to be enough for the second. It is not: a register's
   coordinates are wrong often enough that two unrelated records land on one
   spot. "ABC Nissan, 1300 E Camelback Rd" and "Midway Nissan, 2201 W Bell Rd"
   sit 68 m apart in AFDC and eleven miles apart in Phoenix; a Missouri station
   and a Massachusetts one are 50 m apart by their coordinates. And where the
   coordinates are right, one network's stations in neighbouring buildings
   belong to different hosts — Amazon's garage and the tower next door — and
   are two sites to anyone standing there. So nearness has to be corroborated
   by the one other thing a record says about where it is: its name.

   This is the same standard the OpenStreetMap matcher holds itself to, where
   a second fact — the operator — is what lets a distance count. */
const ADDR_WORD = {
  st: "street", rd: "road", ave: "avenue", av: "avenue", blvd: "boulevard", dr: "drive", ln: "lane",
  ct: "court", pl: "place", pkwy: "parkway", pky: "parkway", hwy: "highway", cir: "circle", trl: "trail",
  ter: "terrace", sq: "square", expy: "expressway", fwy: "freeway", tpke: "turnpike", rte: "route", wy: "way",
  n: "north", s: "south", e: "east", w: "west", ne: "northeast", nw: "northwest", se: "southeast", sw: "southwest",
};
const ADDR_TYPE = new Set(["street", "road", "avenue", "boulevard", "drive", "lane", "court", "place", "parkway",
  "highway", "circle", "trail", "terrace", "square", "expressway", "freeway", "turnpike", "route", "way"]);

/* An address in a form two records can be compared by: "21215 Burbank Blvd"
   and "21215 Burbank Boulevard" are one key, and "300 Massachusetts Avenue
   Under Solar Canopy" stops at "avenue". A line with no house number is kept
   whole — it still equals itself. */
const addressKey = (r) => {
  const k = streetKey(r);
  return k && `${k}|${(r.city || "").toLowerCase().trim()}|${r.state || ""}`;
};
function streetKey(r) {
  if (!r.street) return null;
  const flat = r.street.toLowerCase().replace(/[.,#]/g, " ").replace(/\s+/g, " ").trim();
  const m = /^(\d+)[a-z]?\s+(.+)$/.exec(flat);
  if (!m) return flat;
  let words = m[2].split(" ").map((w) => ADDR_WORD[w] || w);
  const end = words.findIndex((w, i) => i > 0 && ADDR_TYPE.has(w));
  if (end >= 0) {
    // "highway 83", "avenue k": the number or letter is part of the name
    const id = /^(highway|route|road|avenue|expressway)$/.test(words[end]) && /^(\d+[a-z]?|[a-z])$/.test(words[end + 1] || "");
    words = words.slice(0, end + 1 + (id ? 1 : 0));
  }
  return `${m[1]} ${words.join(" ")}`;
}

/* The host a station name names, as the words that are not about the
   hardware: "PIE AE WEST LAKE DC4" and "PIE AE WEST LAKE DC3" are both
   {pie, ae, west, lake}. */
const NAME_NOISE = new Set(["station", "stations", "stn", "dc", "dcfc", "fast", "charger", "chargers", "charging",
  "ev", "evse", "evs", "level", "unit", "lot", "the", "of", "at", "and", "for", "public"]);
function hostWords(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ")
    /* A bare number is a stall number, and "dc4" or "station2" is hardware
       with one attached; both go. A code like "l396" or "mpk18" stays whole —
       it is how ChargePoint names the host, and often the only word two of a
       dealer's stations share. */
    .filter((w) => w.length > 1 && !/^\d+$/.test(w) && !/^[a-z]\d$/.test(w) && !NAME_NOISE.has(w) && !NAME_NOISE.has(w.replace(/\d+/g, "")));
}
/* Two names are the same host when they start with the same word and share
   at least half of the shorter one's. "Ingles" and "Ingles Markets - Skyland
   Plaza" are; "ABC Nissan" and "Midway Nissan" are not, for all that both are
   Nissan dealers. A word counts as shared when one is the other cut short —
   "barn" for "barnstable" — which is how a 20-character name field abbreviates. */
function sameHost(a, b) {
  if (!a.length || !b.length || a[0] !== b[0]) return false;
  const like = (x, y) => x === y || (Math.min(x.length, y.length) >= 4 && (x.startsWith(y) || y.startsWith(x)));
  // counted from both sides and the smaller taken, so the answer does not
  // depend on which record happened to come first
  const hits = (p, q) => p.filter((w) => q.some((v) => like(w, v))).length;
  return Math.min(hits(a, b), hits(b, a)) / Math.min(a.length, b.length) >= 0.5;
}

function collapse(rows, m = 80) {
  const parent = rows.map((_, i) => i);
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
  const host = rows.map((r) => hostWords(r.name));
  const street = rows.map(streetKey);

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
    for (const i of idxs) for (const j of near) {
      if (j <= i || rows[i].state !== rows[j].state) continue;
      if (metres(rows[i], rows[j]) > m) continue;
      if (sameHost(host[i], host[j]) || (street[i] && street[i] === street[j])) union(i, j);
    }
  }
  const byAddr = new Map();
  rows.forEach((r, i) => {
    const k = addressKey(r);
    if (!k) return;
    if (!byAddr.has(k)) byAddr.set(k, []);
    byAddr.get(k).push(i);
  });
  /* A shared address joins two records only while they could be one place.
     The same street line turns up on records forty kilometres apart — a
     dealer group reusing its head-office address — and joining those summed
     two sites' ports into one. Past the bound an id is disbelieved at, an
     address is too. */
  for (const idxs of byAddr.values()) {
    for (let n = 1; n < idxs.length; n++) {
      if (metres(rows[idxs[0]], rows[idxs[n]]) <= OSM_REF_SANITY) union(idxs[0], idxs[n]);
    }
  }

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
    // `pw` is in the key: two cabinets with the same cables at different powers
    // are two kinds, and folding them together would average one away
    const key = `${u.lv ?? ""}|${u.kw ?? ""}|${Object.entries(u.conn).sort().map(([k, v]) => `${k}:${v}@${u.pw?.[k] ?? ""}`).join(",")}`;
    const hit = by.get(key);
    if (hit) hit.n += u.n;
    else by.set(key, { ...u });
  }
  return [...by.values()].sort((a, b) => b.n - a.n);
}



/* Work this browser has done that the snapshot has not caught up with.

   A site mapped ten minutes ago is on OpenStreetMap; it is not in a snapshot
   built an hour before that, and until the next refresh the board would go on
   listing it as missing and offering it back in the queue. Counting it is the
   honest reading: the question the figure asks is "is this on the map", not "is
   this in our copy of the map".

   Bounded by the snapshot's own age rather than kept for ever. Once the
   snapshot is newer than the edit, the snapshot is the better witness and the
   overlay steps aside — so a save that silently failed, or an object somebody
   has since deleted, goes back to reading as missing instead of being masked
   permanently by a claim this browser made once. */
function localOverlay(sites, osmStamp) {
  const done = rememberList(K_DONE).filter((e) => e.at > 0);
  if (!done.length) return 0;
  const snapshot = Date.parse(osmStamp || "") || 0;
  const fresher = new Set(done.filter((e) => e.at > snapshot).map((e) => e.k));
  if (!fresher.size) return 0;
  let n = 0;
  for (const s of sites) {
    if (s.osm) continue;          // hostOnly implies osm, so this covers both
    if (!keysOf(s).some((k) => fresher.has(k))) continue;
    s.osm = true;
    s.osmLocal = true;      // so the board can say how many are counted this way
    n++;
  }
  return n;
}
// edit.js's bucket, named here because the board reads it too
const K_DONE = "cb.improve.done";

/* Distinct source coordinates for one site.

   Deduped at five decimals — about a metre. Two records naming the same spot
   are one pin, not two stacked on each other; anything further apart is a real
   disagreement and worth seeing. Capped because a handful of marks is context
   and twenty is a mess, and ordered so the same source's marks sit together. */
function sourcePins(list) {
  const seen = new Map();
  for (const p of list) {
    if (p.lat == null || p.lon == null) continue;
    const k = `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
    if (!seen.has(k)) seen.set(k, p);
  }
  return [...seen.values()].slice(0, 8);
}

/* What AFDC says about a site beyond its position and its ports — hours, a
   price, which cards the reader takes, where on the property to look. One
   record's worth, taken from the largest record of a collapsed group and
   filled from the others where it is silent: they describe one forecourt, and
   a detail only the second record carries is still a detail of this site. */
const AFDC_EXTRA = ["zip", "hours", "price", "cards", "dir", "geo", "cls", "nid"];
function afdcExtras(base, group) {
  const out = {};
  for (const k of AFDC_EXTRA) {
    const v = base[k] ?? group.find((x) => x[k] != null)?.[k];
    if (v != null) out[k] = v;
  }
  /* A geocoded coordinate only counts against the site when every record in
     the group was geocoded. One surveyed position among them is the one the
     site is placed at. */
  if (out.geo && group.some((x) => !x.geo)) delete out.geo;
  return out;
}

/* Open dates that are not opening dates.

   AFDC's `open_date` is meant to be the day a station went into service. For
   a network onboarded in bulk it is the day the batch was loaded: 247
   ChargePoint sites "opened" on 27 January 2021, 120 EVgo sites on 7 March
   2018. Written to OSM as `start_date` that is a false fact, and a confident
   one. No network opens eight sites on one day, so a date shared by that many
   of its records is treated as the import it is — still shown, never proposed
   as a tag. Counted on raw records, before collapsing, because that is the
   level the batch was loaded at. */
const BULK_DATE_MIN = 8;
function bulkDates(records) {
  const n = new Map();
  for (const r of records) {
    if (!r.open) continue;
    const k = `${r.net}|${r.open}`;
    n.set(k, (n.get(k) || 0) + 1);
  }
  return (net, open) => {
    const c = open ? n.get(`${net}|${open}`) || 0 : 0;
    return c >= BULK_DATE_MIN ? c : 0;
  };
}

/* ---------------------------------------------------------------------- merge */

/* `l2` is the Level 2 payload, or null. With it the board covers every public
   charging station rather than the fast ones alone. Its records go through the
   same door as the fast-charging ones — the same exclusions, and the same
   collapsing, so a network's Level 2 posts beside its DC cabinets become one
   site with both rather than two sites twenty metres apart. A site is "fast"
   if any record behind it has a DC port and Level 2 otherwise. */
function merge(afdc, tesla, ea, ionna, osm, l2 = null) {
  const sites = [];
  const records = l2
    ? [...afdc.sites, ...l2.sites.map((r) => ({ ...r, lvl2: true, ports: 0,
        // the payload writes "24 hours daily" as a flag; here it is words again
        ...(r.h === 1 ? { hours: "24 hours daily" } : {}) }))]
    : afdc.sites;
  let afdcRecords = records.length, afdcSites = 0, cpRecords = 0, cpSites = 0;

  const excluded = { afdc: 0, ea: 0, tesla: 0, eaAc: 0 };

  // access values no source has taught us to read — see ATP_RESTRICTED

  const unknownAccess = new Set();
  const overridden = [];               // AFDC ids for networks a better source supplies
  const bulk = bulkDates(records);
  const byNet = new Map();
  for (const s of records) {
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
    /* A better source replaces three networks' fast charging, and nothing
       replaces their Level 2: a group with no DC record in it is a site in its
       own right, whoever runs it, and goes the ordinary way. */
    const fast = (g) => g.some((x) => !x.lvl2);
    if (OVERRIDE.has(net)) {
      /* Set aside rather than dropped. A better source replaces these three
         networks, but only AFDC publishes an id OSM has a tag for, and
         discarding the record threw that id away with it. Reunited below. */
      for (const g of groups.filter(fast)) {
        const base = g.reduce((a, b) => (b.ports > a.ports ? b : a));
        /* The id was never the only thing worth keeping. AFDC also publishes
           the connector breakdown, the open date and a street address, and the
           source that replaces this record publishes none of them — so a
           Electrify America site used to arrive with no socket detail, no open
           date, and therefore no place in the openings queue at all. Set the
           lot aside and let the reunion fill whatever the better source left
           blank. */
        const open = g.map((x) => x.open).filter(Boolean).sort()[0] || null;
        overridden.push({ net: disp(net), lat: base.lat, lon: base.lon,
          refs: [...new Set(g.map((x) => x.id).filter((id) => id != null))].sort((a, b) => a - b),
          pins: sourcePins(g.map((x) => ({ lat: x.lat, lon: x.lon, src: "AFDC", ref: x.id }))),
          units: mergeUnits(g.flatMap((x) => x.units || [])),
          open, openBulk: bulk(net, open),
          conf: g.map((x) => x.conf).filter(Boolean).sort().pop() || null,
          city: base.city || null, street: base.street || null, fac: base.fac || null,
          afdcPorts: g.reduce((a, b) => a + (b.ports || 0), 0) || null,
          extra: afdcExtras(base, g) });
      }
    }
    for (const g of OVERRIDE.has(net) ? groups.filter((x) => !fast(x)) : groups) {
      // the record with the most on it speaks for the group: DC ports first,
      // then units, so a Level 2 group is not named after whichever came first
      const size = (x) => (x.ports || 0) * 1000 + (x.units || []).reduce((a, u) => a + u.n, 0);
      const base = g.reduce((a, b) => (size(b) > size(a) ? b : a));
      const open = g.map((x) => x.open).filter(Boolean).sort()[0] || null;
      const dcPorts = g.reduce((a, b) => a + (b.ports || 0), 0);
      const units = mergeUnits(g.flatMap((x) => x.units || []));
      sites.push({
        ...afdcExtras(base, g),
        openBulk: bulk(net, open),
        /* No DC port on any record behind it: a Level 2 site. `ports` is then
           its Level 2 ports — there is no fast-charging figure to give, and the
           placeholder 1 that used to stand in for "none" would be a count. */
        ...(dcPorts ? {} : { l2: true }),
        /* What was joined, where anything was: each record's own name and
           address, so the editor can show the evidence for calling them one
           site rather than asking to be believed. */
        ...(g.length > 1 ? { recs: g.map((x) => ({ id: x.id, name: x.name, street: x.street || null }))
                                   .sort((a, b) => a.id - b.id) } : {}),
        net: disp(net), name: base.name, lat: base.lat, lon: base.lon, state: base.state,
        // the street address AFDC publishes, kept for the export: a coordinate
        // in a car park is easier to find when something names the road
        city: base.city || null, street: base.street || null,
        ports: dcPorts || units.reduce((a, u) => a + u.n, 0) || 1,
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
        units,
        conn: [...new Set(g.flatMap((x) => (x.conn || []).map((c) => CONN[c]).filter(Boolean)))],
        /* Where each source put this site, kept rather than collapsed to one
           point. A group is records within 80 m of each other or sharing an
           address, so the spread is the width of a car park — which is exactly
           the distance a mapper is trying to resolve. Showing all of them turns
           "the data says here" into "these three disagree by 40 m, and the
           imagery settles it". */
        pins: sourcePins(g.map((x) => ({ lat: x.lat, lon: x.lon, src: "AFDC", ref: x.id }))),
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
    /* `tpc` and `nacs` are added, not compared. They are the same plug under
       two names — Tesla's proprietary connector before and after it was
       published as a standard — and a site part-way through being relabelled
       lists some stalls under each. Taking the larger of the two, as this did,
       reported 8 sockets at a 12-stall site; the sum equals the stall count at
       every one of the 3,312 open US sites. */
    const sockets = {};
    for (const [k, v] of Object.entries(s.plugs || {})) {
      if (!v || k === "multi") continue;
      const key = k === "tpc" || k === "nacs" ? "nacs" : k === "ccs1" ? "type1_combo" : k === "chademo" ? "chademo" : null;
      if (key) sockets[key] = (sockets[key] || 0) + v;
    }
    sites.push({
      net: owner || "Tesla", name: s.name, lat: s.lat, lon: s.lon, state: s.state,
      ports: s.ports || 1, open: s.open, conf: null, fac: null,
      city: s.city || null, street: s.street || null,
      ...(s.zip ? { zip: s.zip } : {}),
      /* What supercharge.info says about the hardware, which is what turns a
         stall count into something that can be tagged: the site's power, which
         generation of post each stall is, and whether other makes can use it. */
      ...(s.power ? { power: s.power } : {}),
      ...(s.stalls && Object.keys(s.stalls).length ? { stalls: s.stalls } : {}),
      ...(s.host ? { host: s.host } : {}),
      ...(s.dir ? { dir: s.dir } : {}),
      ...(typeof s.other === "boolean" ? { other: s.other } : {}),
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
  const eaPosts = new Map();
  for (const p of ea.sites) {
    if (p.kind !== "point") continue;
    const base = String(p.ref).includes("-") ? String(p.ref).replace(/-[^-]*$/, "") : String(p.ref);
    const dc = p.sockets.type1_combo || p.sockets.chademo || p.sockets.nacs;
    if (dc) units.set(base, (units.get(base) || 0) + 1);
    if (!eaSockets.has(base)) eaSockets.set(base, {});
    const tally = eaSockets.get(base);
    for (const [k, v] of Object.entries(p.sockets)) tally[k] = (tally[k] || 0) + (Number(v) || 1);
    // each post as the operator describes it, kept whole for the inventory
    if (!eaPosts.has(base)) eaPosts.set(base, []);
    eaPosts.get(base).push(p);
  }
  for (const p of ea.sites) {
    if (p.kind !== "site") continue;
    if (p.access && ATP_RESTRICTED.has(p.access)) { excluded.ea++; continue; }
    if (NOT_PUBLIC_NAME.test(p.name || "")) { excluded.ea++; continue; }
    // Not known either way: kept, but counted so a vocabulary change shows up
    // as a figure on the page instead of as a network quietly going missing.
    if (p.access && !ATP_OPEN.has(p.access)) unknownAccess.add(p.access);
    const posts = eaPosts.get(String(p.ref)) || [];
    /* Posts listed, and not one of them DC: a Level 2 site. Thirty of these
       were on a board of fast charging, each as "1 port, CCS" — a placeholder
       count and a connector the site does not have. A site with no posts
       listed at all is a different case and is kept: that is the source being
       incomplete, not the site being slow. */
    if (posts.length && !units.has(String(p.ref))) { excluded.eaAc++; continue; }
    sites.push({ net: "Electrify America", name: p.name, lat: p.lat, lon: p.lon, state: p.state,
      ports: units.get(String(p.ref)) || 1, open: null, conf: null, fac: null,
      city: p.city || null, street: p.street || null,
      ...(p.zip ? { zip: p.zip } : {}), ...(p.web ? { web: p.web } : {}),
      // the operator's own site number, which AFDC quotes for the same place
      nid: String(p.ref),
      /* Set when All the Places has the site and none of its posts — 65 of
         them. `ports` is then the placeholder 1 from the line above, not a
         count, and is replaced with AFDC's once the two records are paired. */
      ...(units.has(String(p.ref)) ? {} : { portsUnknown: true }),
      posts: postKinds(posts),
      src: "ATP electrify_america_us", conn: ["CCS1"], sockets: eaSockets.get(String(p.ref)) || {} });
  }

  for (const p of ionna.sites) {
    const conn = [];
    if (p.sockets.nacs) conn.push("NACS / Tesla");
    if (p.sockets.type1_combo) conn.push("CCS1");
    sites.push({ net: "IONNA", name: p.name, lat: p.lat, lon: p.lon, state: p.state,
      ports: p.capacity || 1, open: null, conf: null, fac: null, src: "ATP ionna_us",
      city: p.city || null, street: p.street || null,
      ...(p.zip ? { zip: p.zip } : {}), ...(p.web ? { web: p.web } : {}),
      ...(p.fee ? { fee: p.fee } : {}), ...(p.pfee ? { pfee: p.pfee } : {}),
      ...(p.hours ? { hours: p.hours, hoursOsm: true } : {}),
      ...(p.capacity ? {} : { portsUnknown: true }),
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
  /* By the operator's own number where both records quote it. Electrify
     America's site id is in AFDC and in All the Places, so 1,196 of its sites
     are paired by declaration; the distance rule is for the rest, and for the
     two networks whose sources share no id. */
  const byNid = new Map();
  for (const t of sites) if (t.nid) byNid.set(`${t.net}|${t.nid}`, t);
  const paired = new Map();            // site → the AFDC groups that answer for it
  for (const g of overridden) {
    let hit = g.extra?.nid ? byNid.get(`${g.net}|${g.extra.nid}`) || null : null;
    // an id is believed up to the same bound as `ref:afdc`: past it, it is a typo
    if (hit && metres(g, hit) > OSM_REF_SANITY) hit = null;
    const byId = !!hit;
    let at = hit ? metres(g, hit) : Infinity;
    if (!hit) {
      const gy = Math.floor(g.lat / siteIx.cell), gx = Math.floor(g.lon / siteIx.cell);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          for (const t of siteIx.grid.get(`${gy + dy},${gx + dx}`) || []) {
            if (t.net !== g.net) continue;
            const d = metres(g, t);
            if (d <= OSM_BRAND_NEAR && d < at) { hit = t; at = d; }
          }
    }
    if (!hit) continue;
    if (!paired.has(hit)) paired.set(hit, []);
    paired.get(hit).push({ g, at, byId });
  }

  let reunited = 0;
  for (const [hit, list] of paired) {
    /* A site paired by id is answered by that record and no other. Before the
       id was carried, a second AFDC group that merely stood within the radius
       was attached as well — its `ref:afdc` written onto a neighbour, and its
       units never counted. Where there is no id, everything in the radius is
       still taken, nearest first: AFDC files an expansion as a record of its
       own often enough that leaving the second one out loses half the site. */
    const named = list.filter((x) => x.byId);
    const use = (named.length ? named : list).sort((a, b) => a.at - b.at);
    const groups = use.map((x) => x.g);
    hit.refs = [...new Set([...(hit.refs || []), ...groups.flatMap((g) => g.refs)])].sort((a, b) => a - b);
    /* Fill gaps only. All the Places and supercharge.info are here because they
       are better on stalls and status, so `ports` is theirs and stays theirs —
       what AFDC adds is everything they do not carry. Where both have a figure
       the better source wins; where only AFDC has one, having it beats not. */
    const units = mergeUnits(groups.flatMap((g) => g.units || []));
    if (!hit.units?.length && units.length) hit.units = units;
    for (const g of groups) {
      if (hit.open == null && g.open) { hit.open = g.open; hit.openBulk = g.openBulk; hit.openSrc = "AFDC"; }
      hit.conf ??= g.conf;
      hit.city ??= g.city;
      hit.street ??= g.street;
      hit.fac ??= g.fac;
      /* Not `geo`: that is a remark about AFDC's own coordinate, and this
         site is standing on its better source's. */
      for (const [k, v] of Object.entries(g.extra || {})) if (k !== "nid" && k !== "geo") hit[k] ??= v;
    }
    /* Kept apart from `ports` rather than reconciled with it. The two sources
       count different things — AFDC counts what it was told, ATP counts what
       the operator's own map shows today — and a panel that quietly averaged
       them would be inventing a number neither publishes. The editor shows both
       and says when they disagree. */
    const afdcPorts = groups.reduce((a, g) => a + (g.afdcPorts || 0), 0);
    if (afdcPorts) hit.afdcPorts = afdcPorts;
    /* The better source had the site and not its ports, so AFDC's count stands
       in for the placeholder — and the site says whose number it is. */
    if (hit.portsUnknown && afdcPorts) { hit.ports = afdcPorts; hit.portsSrc = "AFDC"; }
    /* Two sources, two coordinates, one forecourt. This is the pairing where
       they disagree most — supercharge.info and All the Places aim at the
       stalls, AFDC often at the site entrance — so carrying both is worth more
       here than anywhere else. */
    hit.pins = sourcePins([
      ...(hit.pins || []),
      { lat: hit.lat, lon: hit.lon, src: hit.src },
      ...groups.flatMap((g) => g.pins || [{ lat: g.lat, lon: g.lon, src: "AFDC" }]),
    ]);
    reunited += groups.length;
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

  /* Applied after the matcher has had its say, so it only ever promotes a site
     the snapshot did not already account for. `mapped` is recounted rather than
     incremented — the figure and the sites behind it have to agree. */
  const localMapped = localOverlay(sites, osm.generated);
  // Recounted exactly as the loop above counts it — host-mapped sites included,
  // because `mapped` has always meant "s.osm is true" and a recount that meant
  // something narrower would silently drop 563 of them.
  if (localMapped) mapped = sites.filter((s) => s.osm).length;

  const business = sites.filter((s) => s.business).length;
  return { sites, pipeline, mapped, detailed, refMatched, noted, hostMapped, reunited, excluded, business, businessDeduped,
           localMapped,
           // whether Level 2 is in this merge, and how many sites it added
           l2: !!l2, l2Sites: sites.filter((s) => s.l2).length,
           unknownAccess: [...unknownAccess],
           osmTotal: osm.sites.length, osmDc: osm.sites.filter((o) => o.dc).length,
           osmStamp: osm.generated,
           // Every source dates itself differently and refreshes on its own
           // clock — All the Places publishes weekly, so EA and IONNA are never
           // newer than its last run however current everything else is.
           stamps: { OpenStreetMap: osm.generated, AFDC: afdc.generated, ...(l2 ? { "AFDC Level 2": l2.generated } : {}),
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

  /* Seven numbers per site: lat, lon, network, ports, state, flags, and the
     county's place in the open state's county list (-1 outside it). */
  const stride = 7;
  const counties = VIEW.state ? COUNTIES[VIEW.state] : null;
  const cIx = new Map((counties || []).map((c, i) => [c.id, i]));
  /* Every site, host-mapped ones included: they count as mapped in the figures
     beside the map, so leaving them off it made the two disagree. */
  const rows = M.sites.filter((s) => s.lat != null && s.lon != null);
  ATLAS_ROWS = rows;
  const d = new Int32Array(rows.length * stride);
  let at = 0;
  for (const s of rows) {
    d[at] = Math.round(s.lat * 1e4);
    d[at + 1] = Math.round(s.lon * 1e4);
    d[at + 2] = netIx.get(s.net) ?? -1;
    d[at + 3] = s.ports || 0;
    d[at + 4] = stIx.has(s.state) ? stIx.get(s.state) : -1;
    d[at + 5] = s.osm ? 1 : 0;
    d[at + 6] = counties && s.state === VIEW.state && cIx.has(s.county) ? cIx.get(s.county) : -1;
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
  return { outline, states, points: { nets, states: codes, d, stride }, portWord: M.l2 ? "ports" : "DC ports",
           counties: counties ? { state: VIEW.state, list: counties } : null };
}

/* ------------------------------------------------------------- counties

   A state's counties are loaded the first time it is opened, from
   data/counties/XX.json, and every site in the state is then told which one
   it stands in. That is one point-in-polygon test per site against the few
   counties whose box contains it — a second or less for California with
   Level 2 in. The answer is kept on the site, so the county filter is the
   same cheap comparison the state filter is. */
const COUNTIES = {};

async function loadCounties(state) {
  if (!state) return null;
  if (COUNTIES[state] !== undefined) return COUNTIES[state];
  const body = await grab(`/counties/${state}`).catch(() => null);
  const list = (body?.counties || []).map((c) => {
    let lat0 = 90, lat1 = -90, lon0 = 180, lon1 = -180;
    for (const r of c.rings) for (const [lon, lat] of r) {
      if (lat < lat0) lat0 = lat; if (lat > lat1) lat1 = lat;
      if (lon < lon0) lon0 = lon; if (lon > lon1) lon1 = lon;
    }
    return { ...c, b: { lat0, lat1, lon0, lon1 } };
  });
  return (COUNTIES[state] = list.length ? list : null);
}

const inRings = (lon, lat, rings) => {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
};

/* Which county each of a state's sites stands in. A site a few metres outside
   every county — on a coastline the simplified boundary has cut off — goes to
   the nearest by its box rather than to none, so the county counts add up to
   the state's. */
function assignCounties(sites, state, list) {
  if (!list) return;
  for (const s of sites) {
    if (s.state !== state || s.countyOf === state || s.lat == null) continue;
    s.countyOf = state;
    let hit = list.find((c) => s.lat >= c.b.lat0 && s.lat <= c.b.lat1 && s.lon >= c.b.lon0 && s.lon <= c.b.lon1 &&
      inRings(s.lon, s.lat, c.rings));
    if (!hit) {
      const gap = (c) => Math.max(0, c.b.lat0 - s.lat, s.lat - c.b.lat1) + Math.max(0, c.b.lon0 - s.lon, s.lon - c.b.lon1);
      hit = list.reduce((a, c) => (gap(c) < gap(a) ? c : a), list[0]);
    }
    s.county = hit.id;
  }
}
const countyName = (fips) => (COUNTIES[VIEW.state] || []).find((c) => c.id === fips)?.name || fips;

/* Open what a site is: OpenStreetMap's own page where it is mapped, the
   editor standing on it where it is not. One definition for every place on
   the board that lists or draws a site. */
function openSite(s) {
  if (!s) return;
  if (s.osm && s.osmId) {
    const type = { n: "node", w: "way", r: "relation" }[s.osmId[0]];
    window.open(`https://www.openstreetmap.org/${type}/${s.osmId.slice(1)}`, "_blank", "noopener");
  } else if (window.ImproveAt) window.ImproveAt(s);
}
// the sites behind the packed map points, by point index
let ATLAS_ROWS = [];

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
  /* A county narrows everything a state does — figures, lists, queue,
     export — so it is applied here, with the state, before anything reads
     the sites. The state rail is the exception, as it always was: it is the
     picker, and reads every state. */
  const Sstate = VIEW.state
    ? M.sites.filter((s) => s.state === VIEW.state && (!VIEW.county || s.county === VIEW.county))
    : M.sites;
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
  const nationalPorts = M.sites.reduce((a, s) => a + s.ports, 0);
  const nationalNets = new Set(M.sites.map((s) => s.net)).size;
  const bigNets = [...M.sites.reduce((m, s) => m.set(s.net, (m.get(s.net) || 0) + s.ports), new Map())]
    .filter(([, p]) => p >= 100).length;

  FAILED.length = 0;

  /* ---- scope ---- */
  $("prov").innerHTML =
    `<b>${nf(S.length)}</b> sites · <b>${nf(ports)}</b> ${M.l2 ? "ports" : "DC ports"} · ${esc(shortStamp(M.stamps))}`;
  const stName = VIEW.state ? (STATES?.[VIEW.state]?.name || VIEW.state) : "";
  const coName = VIEW.county ? countyName(VIEW.county) : "";
  const place = coName ? `${coName}, ${VIEW.state}` : stName;
  /* Announced, not shown: the two pills beside it say the same thing to the
     eye, and this says it to a screen reader when a filter changes. */
  $("scope-label").textContent = VIEW.net && VIEW.state ? `${VIEW.net} · ${place}`
    : VIEW.net || (VIEW.state ? place : "All networks · every state");
  safe("scope", () => {
    $("scope-clear").hidden = !VIEW.net && !VIEW.state;
    $("state-pick").classList.toggle("is-set", !!VIEW.state);
    $("reset-view").hidden = !VIEW.state;
    $("net-pick").classList.toggle("is-set", !!VIEW.net);
    $("net-clear").hidden = !VIEW.net;
    const cp = $("county-pick");
    if (cp) {
      cp.hidden = !VIEW.county;
      $("county-chip").textContent = coName || "";
    }
    const chip = $("net-chip");
    chip.innerHTML = VIEW.net ? `${brandMark(VIEW.net)}<span>${esc(VIEW.net)}</span>` : "All networks";
    chip.title = VIEW.net ? "Choose a different network from the list" : "Choose a network from the list";
  });

  /* ---- the atlas ---- */
  safe("atlas", () => {
    const map = $("atlas");
    if (!map) return;
    if (ATLAS_DIRTY) { window.setAtlasData?.(atlasData(M)); ATLAS_DIRTY = false; }
    map.setAttribute("metric", VIEW.mapMetric);
    map.setAttribute("dots", VIEW.dots);
    map.setAttribute("brand", VIEW.net || "");
    map.setAttribute("focus", VIEW.state || "");
    map.setAttribute("county", VIEW.county || "");
    const wait = $("map-wait");
    if (wait) wait.hidden = !!STATES;
    if (wait && !STATES) wait.textContent = "State outlines did not load — the map cannot draw.";
  });

  const hasCounties = !!(VIEW.state && COUNTIES[VIEW.state]);
  $("map-title").textContent = VIEW.county ? place : VIEW.state ? stName : METRIC_TITLE[VIEW.mapMetric];
  $("map-sub").textContent = VIEW.state
    ? `${VIEW.net ? VIEW.net + " · " : ""}${nf(S.length)} sites here, ${nf(missing)} of them missing from the map. ` +
      (VIEW.county || !hasCounties ? "Every dot is one site — click one to open it." : "Shading is the county figure; every dot is one site.")
    : `${VIEW.net ? VIEW.net + ": " : ""}${nf(S.length)} sites, ${nf(missing)} missing. Shading is the state figure; dots are the sites themselves.`;
  $("map-hint").textContent = VIEW.county
    ? `Click a site to open it · click another county to move, or outside ${stName} to zoom out`
    : VIEW.state
      ? `Click a site to open it${hasCounties ? " · click a county to zoom into it" : ""} · click outside the state to zoom out`
      : "Click a state to zoom into its sites";
  safe("level 2 switch", () => {
    const sw = $("l2-toggle");
    if (sw) { sw.setAttribute("aria-checked", String(!!M.l2)); sw.classList.toggle("is-on", !!M.l2); }
    const by = $("net-by");
    if (by) by.textContent = M.l2 ? "By ports" : "By DC ports";
    const foot = $("net-foot");
    if (foot) foot.textContent = `Ranked by ${M.l2 ? "" : "DC "}ports. Bars show the share of that network’s sites already on OpenStreetMap.`;
  });
  $("legend-mapped").textContent = nf(mapped);
  $("legend-missing").textContent = nf(missing);

  seg("metric-seg", METRIC_SEG, VIEW.mapMetric, (k) => { VIEW.mapMetric = k; render(MERGED); });
  seg("dots-seg", DOTS_SEG, VIEW.dots, (k) => { VIEW.dots = k; render(MERGED); });

  /* ---- rail ---- */
  safe("network rail", () => renderRail(ranked, nets));

  /* ---- figures ---- */
  // a network with no sites in the chosen state is an empty slice, not NaN%
  const pct = S.length ? (mapped / S.length) * 100 : null;
  // mapped in this browser, not yet visible in the snapshot behind the figures
  const localHere = S.filter((s) => s.osmLocal).length;
  /* Coverage leads, because it is the question the board exists to answer;
     the gap comes second, because it is the work. The other three are context.
     Each is a sign: guide green for what is on the map, work-zone orange for
     what is not, plain for plain facts. */
  const kpis = [
    /* The sub-line owns up to the overlay. A figure that quietly counted work
       the snapshot cannot see would be the kind of number you stop trusting
       once you notice — better to show it and say where it came from. */
    ["guide", "On the map", pct == null ? "—" : `${pct.toFixed(1)}%`,
     `${nf(mapped)} of ${nf(S.length)} sites${localHere ? ` · ${nf(localHere)} awaiting refresh` : ""}`, pct],
    ["work", "Missing", nf(missing), "no station on OSM"],
    ["plain", "Sites", nf(S.length), VIEW.net || VIEW.state ? "in this slice"
      : M.l2 ? `fast and Level 2 · ${nf(S.filter((s) => s.l2).length)} are Level 2` : "public DC fast charging"],
    [`plain`, M.l2 ? "Ports" : "DC ports", nf(ports), S.length ? `${(ports / S.length).toFixed(1)} per site` : "—"],
    VIEW.net
      ? ["plain", "Share of US ports", `${((ports / nationalPorts) * 100).toFixed(1)}%`, `of ${nf(nationalPorts)}`]
      : ["plain", "Networks", nf(nationalNets), `${nf(bigNets)} carry 100+ ports`],
  ];
  const kw = $("kpis");
  kw.innerHTML = "";
  for (const [kind, label, value, sub, bar] of kpis) {
    const k = el("div", `sign sign--${kind}`);
    const v = el("div", "sign-val");
    countUp(v, value);
    k.append(el("div", "sign-label", label), v);
    if (kind === "guide") {
      const track = el("div", "sign-bar"), fill = el("span");
      track.append(fill);
      k.append(track);
      // width starts at 0 (stylesheet); set it next frame so the transition runs
      requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = `${(bar || 0).toFixed(1)}%`; }));
    }
    k.append(el("div", "sign-sub", esc(sub)));
    kw.append(k);
  }

  /* ---- three columns ---- */
  safe("state rail", () => renderStateCoverage(choroSites));
  safe("work queue", () => renderOpenings(S));
  safe("method", () => renderMethod(M, S));
  safe("export button", paintExport);
  safe("networks table", () => renderNetworks(Sstate, ranked));

  $("view-note").textContent = VIEW.state
    ? `Every figure on this page is for ${place}.`
    : "";

  const D = M.dedupe;
  $("dedupenote").innerHTML = `<dl class="method-list">${[
    ["Dedupe", `${nf(D.afdcRecords)} AFDC records to ${nf(D.afdcSites)} sites. ChargePoint ${nf(D.cpRecords)} to ${nf(D.cpSites)}${M.l2 ? "" : "; every other network under 2%"}.`],
    ...(M.l2 ? [["Level 2", `${nf(M.l2Sites)} sites have no DC port and are here because Level 2 is switched on. They come from AFDC, Tesla's destination chargers among them, and are matched against OpenStreetMap by the same rules. Where a network's Level 2 posts stand with its fast chargers they are one site.`]] : []),
    ["OSM match", `${OSM_NEAR} m against ${nf(M.osmTotal)} mapped stations (${nf(M.osmDc)} with socket tags), widened by the size of any mapped area, or ${OSM_BRAND_NEAR} m for a match on the same operator — but never between two different networks, however close they stand. ${nf(M.refMatched)} sites skipped all of that and matched outright on a <span class="mono">ref:afdc</span> or <span class="mono">ref:supercharge_info</span> the mapper had already recorded.`],
    ["On a host", `Some charging is recorded on the business hosting it rather than mapped as a station. Where that business also carries the <span class="mono">ref:afdc</span> this site is listed under, it counts as mapped — ${nf(M.hostMapped)} sites. Where the tag stands alone it is only <i>noted</i>, and ${nf(M.noted)} sites sit there.`],
    ["Excluded", `${nf(M.excluded.afdc)} gated or key-only, ${nf(M.excluded.ea)} customers-only or test sites, ${nf(M.excluded.tesla)} permit-only` +
      `${M.excluded.eaAc ? `, ${nf(M.excluded.eaAc)} Electrify America sites with Level 2 posts only` : ""}.` +
      (M.unknownAccess?.length
        ? ` A source is publishing <span class="mono">access</span> values this board does not
           recognise — ${M.unknownAccess.map((v) => `<span class="mono">${esc(v)}</span>`).join(", ")} —
           and those sites have been kept rather than dropped. Worth a look: the vocabulary has changed.`
        : "")],
  ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
  const xn = $("xnote");
  if (xn) xn.innerHTML = "";

  $("status").innerHTML = FAILED.length
    ? `<span class="chip" style="color:var(--miss)">${FAILED.length} failed</span> ${esc(FAILED.join("; "))}`
    : freshness(M.stamps);
  const bad = $("load-error");
  if (bad) bad.hidden = true;
}

/* The network list: every network in the current state, ranked by DC ports,
   with the share of its own sites already on the map as a bar underneath. The
   bar sits under the name rather than beside it so a long operator name is
   not squeezed into a third of the width, and the percentage is printed next
   to it because a bar alone asks the reader to estimate. */
function renderRail(ranked, nets) {
  const host = $("netrail");
  if (!host) return;
  const q = (VIEW.query || "").trim().toLowerCase();
  const rows = ranked.filter(([n]) => !q || n.toLowerCase().includes(q));
  const all = $("net-all");
  if (all) {
    all.textContent = `All ${nf(ranked.length)}`;
    all.hidden = !VIEW.net;
  }
  const tab = $("tab-nets");
  if (tab) tab.innerHTML = `Networks <small>${nf(ranked.length)}</small>`;
  host.innerHTML = rows.length
    ? rows.map(([n, [c, p, m]]) => {
        const share = c ? Math.round((m / c) * 100) : 0;
        const on = n === VIEW.net;
        return `<button class="row${on ? " is-on" : ""}" data-net="${esc(n)}" aria-pressed="${on}"
                  title="${esc(n)} — ${nf(m)} of ${nf(c)} sites on the map, ${nf(p)} ports">
          <span class="row-name">${brandMark(n)}<span>${esc(n)}</span></span>
          <span class="row-fig">${nf(p)}</span>
          <span class="row-track"><span class="row-fill" style="width:${share}%"></span></span>
          <span class="row-sub">${share}% mapped</span>
        </button>`;
      }).join("")
    : `<p class="empty">No network matches that.</p>`;
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
    ...(M.localMapped ? [["Mapped here, awaiting refresh", nf(M.localMapped)]] : []),
  ];
  host.innerHTML = rows.map(([k, v]) =>
    `<div class="fact"><span>${esc(k)}</span><i></i><b>${esc(v)}</b></div>`).join("");
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
      `<span class="chip" style="color:var(--miss)">not refreshed</span> ` +
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
    ? `<span class="chip" style="color:var(--ok)">updated</span> ${freshness(merged.stamps)}`
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

/* A bay is one vehicle charging, which is exactly what OSM's `capacity` counts,
   and AFDC's charging unit is the same thing. A cabinet offering CHAdeMO and
   CCS hands the driver a choice of cable, not a second place to park, so its
   two connectors are one bay.

   Checked against the whole feed rather than assumed: summing `n` over a site's
   DC units reproduces AFDC's own `ev_dc_fast_num` on 14,895 of 14,898 sites,
   where summing their connectors manages 9,373. The unit is the bay; the
   connector count never is. Counting cables is how a site of twin-head
   dispensers ends up claiming twice the capacity it has — which is most of a
   network like EV Gateway, whose DC fleet is nearly all CHAdeMO+CCS. */
/* The unit's own level where the payload gives one. The plug alone cannot
   say: NACS is a Supercharger stall and a hotel wall connector both. */
const isDcUnit = (u) => u.lv ? false
  : Object.keys(u.conn || {}).some((k) => DC_SOCKET.has(CONN_SOCKET[k]));

function siteBays(units) {
  let dc = 0, ac = 0;
  for (const u of units || []) { if (isDcUnit(u)) dc += u.n; else ac += u.n; }
  return { dc, ac, total: dc + ac };
}

/* Sockets, unlike bays, are counted per cable: a twin-head cabinet really does
   carry one CHAdeMO and one CCS, and `socket:*` is where that belongs. Both
   numbers are wanted and they are not the same number. */
function unitSockets(units) {
  const total = {};
  for (const u of units || []) {
    for (const [k, n] of Object.entries(u.conn || {})) {
      const key = CONN_SOCKET[k];
      if (key) total[key] = (total[key] || 0) + n * u.n;
    }
  }
  return total;
}

/* ---------------------------------------------------------- inventory

   What stands at a site, worked out once and read by everything that has to
   say it: the tags the editor proposes, the dispensers it offers to place, the
   station totals it writes, the export.

   The unit of account is the *port* — one vehicle charging — because that is
   the one thing every source counts, whatever it calls it. AFDC's "charging
   unit" is a port (its `port_count` is 1 on all 85,371 of them, and summing
   them reproduces `ev_dc_fast_num` at every site). supercharge.info's stall is
   a port. An Electrify America post in All the Places is a port. A port has
   one or more cables, and they are not the same number: 12,800 AFDC ports
   carry two connector types, and 799 carry two cables of one type that still
   charge one car. So:

     capacity          ports
     socket:<type>     cables of that type, summed over ports
     …:output          what that cable delivers — per connector, never per port

   A *kind* is `n` identical ports. Kinds are what a mapper places: "six of
   these, two of those". Where a source gives only totals — IONNA publishes
   "4 CCS, 2 NACS, capacity 6" — the kinds are whatever those totals force and
   nothing more is read into them.

   Sources disagree, and the disagreement is kept rather than averaged. The
   site's own source (the one it was taken from in the merge) decides the port
   count, because that is why it was preferred; AFDC's breakdown is used on top
   of it only when it accounts for the same number of ports, and otherwise the
   two figures are both reported and the mapper, who can see the forecourt,
   chooses. */

const SOCKET_LABEL = {
  type1_combo: "CCS", chademo: "CHAdeMO", nacs: "NACS", type1: "J1772",
  nema_5_15: "NEMA 5-15", nema_5_20: "NEMA 5-20", nema_14_50: "NEMA 14-50",
};
const socketLabel = (t) => SOCKET_LABEL[t] || t;
// DC before AC, then the order a driver would list them in
const SOCKET_ORDER = ["type1_combo", "nacs", "chademo", "type1", "nema_14_50", "nema_5_20", "nema_5_15"];
const socketRank = (t) => { const i = SOCKET_ORDER.indexOf(t); return i < 0 ? 99 : i; };
const sourceName = (src) => /^ATP/.test(src || "") ? "All the Places" : src || "the source";

/* AC or DC. Stated by the source where it states it (`dc` on the kind, from
   AFDC's charging level); otherwise read off the plugs, which is right for
   everything but NACS and is all an older payload allows. */
const kindIsDc = (k) => k.dc ?? Object.keys(k.conn).some((t) => DC_SOCKET.has(t));
const kindKey = (k) => (kindIsDc(k) ? "" : "ac|") + Object.keys(k.conn).sort()
  .map((t) => `${t}:${k.conn[t]}@${k.kw?.[t] ?? ""}`).join(",");

/* Fold identical ports together and put them in a stable order: DC first,
   strongest first, most numerous first. The order is the order the editor
   offers them in, so it wants to be the order somebody would place them. */
function foldKinds(list) {
  const by = new Map();
  for (const k of list) {
    if (!k.n || !Object.keys(k.conn).length) continue;
    const key = kindKey(k);
    const hit = by.get(key);
    if (hit) hit.n += k.n;
    else by.set(key, { ...k, conn: { ...k.conn }, kw: { ...(k.kw || {}) }, dc: kindIsDc(k) });
  }
  const best = (k) => Math.max(0, ...Object.values(k.kw || {}).map((v) => v || 0));
  return [...by.values()].sort((a, b) => (b.dc - a.dc) || best(b) - best(a) || b.n - a.n);
}

/* AFDC's units, in OSM's vocabulary.

   Two payload shapes arrive here. The current one carries `pw`, the power of
   each connector, on every unit with more than one connector type. The one
   before it carried a single `kw` per unit — the largest — which for a
   multi-connector unit does not say which connector it belongs to. Rather than
   guess, power is left unknown there: an output that is missing gets filled in
   by whoever is looking at the cabinet, and one that is wrong gets believed. */
function afdcKinds(units) {
  const out = [];
  for (const u of units || []) {
    const names = Object.keys(u.conn || {});
    const conn = {}, kw = {};
    for (const k of names) {
      const t = CONN_SOCKET[k];
      if (!t) continue;
      conn[t] = (conn[t] || 0) + u.conn[k];
      const p = u.pw ? u.pw[k] : names.length === 1 ? u.kw : null;
      // J3271 and TESLA are one socket in OSM; the stronger figure stands
      if (p > 0) kw[t] = Math.max(kw[t] || 0, p);
    }
    if (Object.keys(conn).length) out.push({ n: u.n, conn, kw, src: "AFDC", ...(u.lv ? { dc: false } : {}) });
  }
  return foldKinds(out);
}

/* Electrify America's posts, as its own site lists them. Each is a port with
   the connectors it offers and what each delivers. What the operator does not
   say is how many cables: the connector is `yes`, never a number, so a count
   of 1 here means "present" and the kind is marked `vague` so nothing
   downstream mistakes it for a measurement. */
function postKinds(posts) {
  return foldKinds((posts || []).map((p) => ({
    n: 1,
    conn: Object.fromEntries(Object.entries(p.sockets || {}).filter(([, n]) => n > 0)),
    kw: { ...(p.out || {}) },
    ...(p.amp ? { amp: p.amp } : {}),
    ...(p.volt ? { volt: p.volt } : {}),
    ...(p.vague?.length ? { vague: true } : {}),
    src: "All the Places",
  })));
}

/* Which generations of Supercharger post a site has, from supercharge.info's
   stall breakdown: [["v3", 24], ["v4", 8]]. */
const teslaGens = (s) => Object.entries(s.stalls || {}).filter(([k, n]) => /^(v\d|urban)$/.test(k) && n > 0);

/* A Supercharger site from supercharge.info: a stall count, which plugs those
   stalls carry, one power figure for the site. Every stall is a port with a
   NACS cable; `ccs1` of them also carry CCS (a Magic Dock, or a V4 post with
   both).

   The power figure is the site's best stall. Where every stall is one
   generation that is every stall's, and each port carries it. Where the site
   mixes generations it is not: New Braunfels is 24 V3 stalls and 8 V4, listed
   at 500 kW, and the feed does not say which of the 32 deliver it — the V3
   stalls, which are the ones with the CCS adapters, certainly do not. So on a
   mixed site no port is given a power here. The site's figure is still true
   as the fastest NACS stall and is reported as that (`peak`, below); the CCS
   figure is simply not known. */
function teslaKinds(s) {
  const stalls = s.ports || 0;
  if (!stalls) return [];
  const nacs = s.sockets?.nacs || 0;
  const ccs = Math.min(s.sockets?.type1_combo || 0, stalls);
  if (!nacs && !ccs) return [];
  const mixed = teslaGens(s).length > 1;
  const kw = (types) => Object.fromEntries(s.power && !mixed ? types.map((t) => [t, s.power]) : []);
  const both = Math.min(ccs, nacs);
  const more = mixed ? { mixed: true } : {};
  return foldKinds([
    { n: both, conn: { nacs: 1, type1_combo: 1 }, kw: kw(["nacs", "type1_combo"]), src: "supercharge.info", ...more },
    { n: Math.max(0, nacs - both), conn: { nacs: 1 }, kw: kw(["nacs"]), src: "supercharge.info", ...more },
    { n: Math.max(0, ccs - both), conn: { type1_combo: 1 }, kw: kw(["type1_combo"]), src: "supercharge.info", ...more },
  ]);
}

/* A source that states totals and a capacity, and nothing about which port has
   which cable (IONNA). When the cables add up to the capacity, each cable is
   its own port and the kinds follow. When they do not, the arrangement is not
   known and no kinds are offered — the totals still stand. */
function totalKinds(s) {
  const counted = Object.entries(s.sockets || {}).filter(([, n]) => Number(n) > 0);
  const cables = counted.reduce((a, [, n]) => a + Number(n), 0);
  if (!counted.length || s.portsUnknown || cables !== s.ports) return [];
  return foldKinds(counted.map(([t, n]) => ({ n: Number(n), conn: { [t]: 1 }, kw: {}, src: sourceName(s.src) })));
}

const kindBays = (kinds) => {
  let dc = 0, ac = 0;
  for (const k of kinds) { if (k.dc) dc += k.n; else ac += k.n; }
  return { dc, ac, total: dc + ac };
};

/* Cables and their powers, per socket type, across a set of kinds.
   `powers` is [[kW, cables], …] strongest first; `unknown` is how many cables
   have no figure from any source. */
function kindSockets(kinds) {
  const out = {};
  for (const k of kinds) {
    for (const [t, c] of Object.entries(k.conn)) {
      const e = out[t] || (out[t] = { n: 0, by: new Map(), unknown: 0, vague: false });
      e.n += c * k.n;
      if (k.vague) e.vague = true;
      const p = k.kw?.[t];
      if (p > 0) e.by.set(p, (e.by.get(p) || 0) + c * k.n);
      else e.unknown += c * k.n;
    }
  }
  for (const e of Object.values(out)) {
    e.powers = [...e.by].sort((a, b) => b[0] - a[0]);
    e.max = e.powers[0]?.[0] ?? null;
    delete e.by;
  }
  return out;
}

const fmtKw = (v) => `${Number.isInteger(v) ? v : Math.round(v * 10) / 10} kW`;

/* One kind in words: "CCS 350 kW", "CCS 150 kW + CHAdeMO 50 kW",
   "2× CCS 350 kW". */
function kindLabel(k) {
  return Object.keys(k.conn).sort((a, b) => socketRank(a) - socketRank(b)).map((t) =>
    `${k.conn[t] > 1 ? `${k.conn[t]}× ` : ""}${socketLabel(t)}${k.kw?.[t] ? ` ${fmtKw(k.kw[t])}` : ""}`).join(" + ");
}

function siteInventory(s) {
  if (s._inv) return s._inv;
  const flags = [];
  const own = /supercharge/i.test(s.src || "") ? teslaKinds(s)
    : s.posts?.length ? s.posts
    : s.src === "AFDC" ? [] : totalKinds(s);
  const afdc = afdcKinds(s.units);
  const ownName = sourceName(s.src);
  const ownBays = kindBays(own), afdcBays = kindBays(afdc);

  let kinds, src;
  const claims = [];
  if (s.src === "AFDC" || !own.length) {
    kinds = afdc; src = afdc.length ? "AFDC" : null;
    if (s.src !== "AFDC" && !s.portsUnknown && s.ports) claims.push({ src: ownName, n: s.ports });
    if (afdcBays.dc) claims.push({ src: "AFDC", n: afdcBays.dc });
  } else {
    claims.push({ src: ownName, n: ownBays.dc });
    if (afdcBays.dc) claims.push({ src: "AFDC", n: afdcBays.dc });
    const ownTypes = new Set(own.filter((k) => k.dc).flatMap((k) => Object.keys(k.conn)));
    const afdcTypes = new Set(afdc.filter((k) => k.dc).flatMap((k) => Object.keys(k.conn)));
    const typesAgree = [...ownTypes].every((t) => afdcTypes.has(t));
    /* AFDC's breakdown replaces the better source's only when it describes the
       same site: the same number of ports, and every connector the operator
       lists. Then it is the fuller of two consistent accounts — it has the
       cable counts Electrify America omits and the per-stall power
       supercharge.info does not publish. Anything less than agreement and it
       is a second opinion, reported beside the first. */
    if (afdcBays.dc && afdcBays.dc === ownBays.dc && typesAgree) {
      kinds = afdc.map((k) => ({ ...k })); src = "AFDC";
      borrow(kinds, own, ["kw", "amp", "volt"]);
      // the operator's Level 2 posts, if it lists any AFDC does not
      if (!afdcBays.ac && ownBays.ac) kinds.push(...own.filter((k) => !k.dc));
    } else {
      kinds = own.map((k) => ({ ...k, kw: { ...k.kw } })); src = ownName;
      /* AFDC's power is borrowed for a connector the site's own source left
         blank — except on a mixed-generation Supercharger site, where the
         blank is deliberate: AFDC's figure there describes the stalls it knew
         about, and spreading it over the ones it did not is the very guess the
         blank was avoiding. */
      if (!own.some((k) => k.mixed)) borrow(kinds, afdc, ["kw"]);
      if (!ownBays.ac && afdcBays.ac) kinds.push(...afdc.filter((k) => !k.dc));
      if (afdcBays.dc && afdcBays.dc !== ownBays.dc) {
        flags.push({ level: "warn", text:
          `${ownName} counts ${nf(ownBays.dc)} fast-charging port${ownBays.dc === 1 ? "" : "s"} here; ` +
          `AFDC itemises ${nf(afdcBays.dc)}. ${ownName}'s figure is proposed — count what the imagery shows.` });
      } else if (afdcBays.dc && !typesAgree) {
        flags.push({ level: "warn", text:
          `${ownName} lists ${[...ownTypes].map(socketLabel).join(" and ")} here; AFDC lists ` +
          `${[...afdcTypes].map(socketLabel).join(" and ") || "none of them"}. ${ownName}'s connectors are proposed.` });
      }
    }
  }
  kinds = foldKinds(kinds);

  const bays = kindBays(kinds);
  const sockets = kindSockets(kinds);
  /* The one thing a mixed Supercharger site does state: its fastest stall. It
     is a NACS stall by definition, so the site's NACS output can say so even
     though no individual port can. */
  if (src === "supercharge.info" && s.power && sockets.nacs && sockets.nacs.max == null) sockets.nacs.peak = s.power;

  /* No kinds at all: a source that named its connectors and counted nothing
     behind them. The totals are what there is — a port count, and connector
     types marked present. */
  let capacity = bays.total || null;
  if (!kinds.length) {
    capacity = s.portsUnknown ? null : s.ports || null;
    const counted = Object.entries(s.sockets || {}).filter(([, n]) => Number(n) > 0);
    for (const [t, n] of counted) sockets[t] = { n: Number(n), powers: [], max: null, unknown: Number(n), vague: false };
    if (!counted.length) {
      for (const c of s.conn || []) {
        const t = { CCS1: "type1_combo", "NACS / Tesla": "nacs", CHAdeMO: "chademo", "J1772 (AC)": "type1" }[c];
        if (t) sockets[t] = { n: null, powers: [], max: null, unknown: 0, vague: true };
      }
    }
  }

  /* ---- what is worth saying about it ---- */
  if (s.portsSrc === "AFDC") {
    flags.push({ level: "info", text:
      `${ownName} lists this site without its posts, so the port count is AFDC's.` });
  }
  if (s.portsUnknown && !s.portsSrc) {
    flags.push({ level: "warn", text:
      `No source counts the ports here. Capacity is left off — add it from the imagery.` });
  }
  /* Records joined by address rather than by standing together. They are
     usually one property — a campus, a dealer's two lots — and the count is
     then the property's, not the forecourt's. */
  const spread = (s.refs?.length || 0) > 1 && s.src === "AFDC"
    ? Math.max(0, ...(s.pins || []).map((p) => metres(s, p))) : 0;
  if (spread > 150) {
    flags.push({ level: "warn", text:
      `The ${nf(s.refs.length)} AFDC records behind this site share an address and stand up to ` +
      `${nf(Math.round(spread))} m apart. The counts cover all of them — if the imagery shows ` +
      `separate sites, this is more than the one in front of you.` });
  }
  const twin = kinds.filter((k) => Object.values(k.conn).some((c) => c > 1));
  if (twin.length) {
    const n = twin.reduce((a, k) => a + k.n, 0);
    flags.push({ level: "info", text:
      `${nf(n)} port${n === 1 ? " has" : "s have"} two cables of one type and charge one car at a time, ` +
      `so sockets outnumber capacity here.` });
  }
  if (kinds.some((k) => k.vague)) {
    flags.push({ level: "info", text:
      `${ownName} says which connectors each post has, not how many cables. ` +
      `Socket counts here are posts carrying that connector.` });
  }
  for (const [t, e] of Object.entries(sockets)) {
    if (e.powers.length > 1) {
      flags.push({ level: "info", text:
        `${socketLabel(t)} power varies: ${e.powers.map(([kw, c]) => `${nf(c)} at ${fmtKw(kw)}`).join(", ")}` +
        `${e.unknown ? `, ${nf(e.unknown)} unstated` : ""}. The fastest is proposed as the output.` });
    } else if (e.n && e.unknown === e.n && kinds.some((k) => k.dc && k.conn[t]) && !e.peak && !kinds.some((k) => k.mixed)) {
      flags.push({ level: "info", text: `No source states the ${socketLabel(t)} power here.` });
    }
  }
  const gens = teslaGens(s);
  if (gens.length > 1 && src === "supercharge.info" && s.power) {
    flags.push({ level: "info", text:
      `Mixed Supercharger hardware (${gens.map(([k, n]) => `${nf(n)} ${k.toUpperCase()}`).join(", ")}). ` +
      `${fmtKw(s.power)} is the fastest stall here; which stalls deliver it is not published, ` +
      `so the dispensers carry no power figure${sockets.type1_combo ? " and CCS has none at all" : ""}.` });
  }

  const agree = new Set(claims.map((c) => c.n)).size <= 1;
  return (s._inv = { kinds, src, bays, capacity, sockets, claims, agree, flags });
}

/* Fill what one account leaves blank from the other, connector by connector.
   Only ever a gap, and only when the donor is unambiguous: if it offers CCS at
   both 350 and 150 kW there is no telling which a given port is, so nothing is
   taken. */
function borrow(kinds, donor, fields) {
  for (const f of fields) {
    const seen = {};
    for (const d of donor) {
      for (const [t, v] of Object.entries(d[f] || {})) {
        if (v > 0) (seen[t] ||= new Set()).add(v);
      }
    }
    for (const k of kinds) {
      for (const t of Object.keys(k.conn)) {
        if (k[f]?.[t] > 0) continue;
        /* Current and voltage follow the power they were quoted with: a 350 kW
           post is 1000 V, a 150 kW one 500 V, and giving every CCS cable the
           same pair would be wrong for half of them. So those are matched on
           the donor's power for that connector, not merely on its type. */
        if (f !== "kw") {
          const match = donor.find((d) => d[f]?.[t] > 0 && d.kw?.[t] && d.kw[t] === k.kw?.[t]);
          if (match) (k[f] ||= {})[t] = match[f][t];
          continue;
        }
        if (seen[t]?.size === 1) (k[f] ||= {})[t] = [...seen[t]][0];
      }
    }
  }
}

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
    /* The same inventory the editor proposes from, so the file and the panel
       cannot say different things about one site: ports as `capacity`, cables
       per connector, and each connector's own output where a source states
       it. */
    const inv = siteInventory(s);
    const sockets = {};
    for (const [t, e] of Object.entries(inv.sockets)) {
      sockets[`socket:${t}`] = e.n ?? "yes";
      if (e.max || e.peak) sockets[`socket:${t}:output`] = fmtKw(e.max || e.peak);
    }
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
        "ref:supercharge_info": s.sc ? String(s.sc) : null,
        capacity: inv.capacity,
        ...sockets,
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
      note: `Unmapped ${MERGED?.l2 ? "public charging" : "DC fast charging"} sites - leads from the sources named per feature, ` +
            "not survey data. Positions are the operator's own and want checking against imagery.",
      sources: "AFDC (US DOE/NLR), supercharge.info, All the Places; matched against OpenStreetMap",
    },
    features,
  };
}

// six decimals is ~10 cm, past which these coordinates are not honest anyway
const round6 = (v) => Math.round(v * 1e6) / 1e6;

const missingHere = () => (MERGED?.sites || []).filter((s) =>
  !s.osm && s.lat != null && s.lon != null &&
  (!VIEW.state || s.state === VIEW.state) && (!VIEW.county || s.county === VIEW.county) &&
  (!VIEW.net || s.net === VIEW.net));

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
/* The tick a finished state wears. A word goes with it everywhere it is used,
   so "done" never rests on a glyph or a colour alone. */
const DONE_MARK = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12.5 9.5 18 20 6.5"/></svg>`;
const STATE_ORDER = [["pct", "% mapped"], ["gap", "missing"]];

function renderStateCoverage(sites) {
  const host = $("staterail");
  if (!host) return;

  seg("state-order", STATE_ORDER, VIEW.stateOrder, (k) => { VIEW.stateOrder = k; render(MERGED); });

  const agg = new Map();
  for (const s of sites) {
    if (!s.state) continue;
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

  /* States with nothing left to map, in the slice on screen. They are the
     ones a mapper can stop looking at, so they are marked wherever a state
     appears — this list, the map, its legend — rather than left to be read
     off a bar that happens to be full. */
  const full = [...agg].filter(([, a]) => a.n > 0 && a.gap === 0).length;
  const key = $("legend-done");
  if (key) {
    key.hidden = !full;
    key.querySelector("b").textContent = nf(full);
  }

  const note = $("statemap-note");
  if (note) {
    note.textContent = (VIEW.stateOrder === "gap"
      ? `Sites with no station on OpenStreetMap. Bar is the share already mapped.`
      : `Least mapped first. Bar and figure are the share already mapped; states under ${STATE_MIN_SITES} sites are greyed, being too small to rank.`) +
      (full ? ` ${nf(full)} ${full === 1 ? "state has" : "states have"} nothing missing${VIEW.net ? ` for ${VIEW.net}` : ""} and ${full === 1 ? "is" : "are"} ticked.` : "");
  }

  const tab = $("tab-states");
  if (tab) tab.innerHTML = `States <small>${nf(agg.size)}</small>`;

  /* The figure the list is ordered by leads; the other one sits beside the
     bar, so neither order hides what the other would have shown. */
  const byGap = VIEW.stateOrder === "gap";
  host.innerHTML = rows.length
    ? rows.map((r) => r.gap === 0 ? `
      <button class="row is-full${r.code === VIEW.state ? " is-on" : ""}"
              data-state="${r.code}" aria-pressed="${r.code === VIEW.state}"
              title="${esc(r.name)} — all ${nf(r.n)} sites are on the map">
        <span class="row-name"><span class="code">${r.code}</span><span>${esc(r.name)}</span></span>
        <span class="row-fig row-done">${DONE_MARK}All mapped</span>
        <span class="row-track"><span class="row-fill" style="width:100%"></span></span>
        <span class="row-sub">${nf(r.n)} site${r.n === 1 ? "" : "s"}</span>
      </button>` : `
      <button class="row${r.code === VIEW.state ? " is-on" : ""}${r.n < STATE_MIN_SITES ? " is-thin" : ""}"
              data-state="${r.code}" aria-pressed="${r.code === VIEW.state}"
              title="${esc(r.name)} — ${nf(r.m)} of ${nf(r.n)} mapped, ${nf(r.gap)} missing, ${nf(r.ports)} ports">
        <span class="row-name"><span class="code">${r.code}</span><span>${esc(r.name)}</span></span>
        <span class="row-fig">${byGap ? nf(r.gap) : Math.floor(r.pct) + "%"}</span>
        <span class="row-track"><span class="row-fill" style="width:${r.pct.toFixed(1)}%"></span></span>
        <span class="row-sub">${byGap ? Math.floor(r.pct) + "% mapped" : nf(r.gap) + " missing"}</span>
      </button>`).join("")
    : `<p class="empty">No state matches that.</p>`;

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
// how many of them the queue lists; the note above it says when there are more
const OPEN_SHOWN = 14;

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
  const natRecent = MERGED.sites.filter((s) => openedWithinDays(s, 30));
  const natMapped = natRecent.filter((s) => s.osm).length;

  const shown = rows.slice(0, OPEN_SHOWN);
  const note = $("open-note");
  if (note) {
    note.textContent =
      `${nf(rows.length)} of ${nf(natRecent.length)} recent openings` +
      `${VIEW.net || VIEW.state ? " in this slice" : ""} · ` +
      `${nf(natMapped)} of ${nf(natRecent.length)} nationally are already mapped` +
      (rows.length > shown.length ? ` · newest ${nf(shown.length)} shown` : "");
  }

  /* The last cell says what a click does as well as what the site's state is:
     the arrow on "Missing" leads into the editor, the one on "On map" leads
     out to the element. A word and an icon, so the difference does not rest
     on colour. */
  const go = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`;
  const out = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 16 17 7M9 7h8v8"/></svg>`;
  host.innerHTML = !rows.length
    ? `<p class="empty">Nothing opened in this slice in the last 30 days.
        Clear the network or the state to widen it.</p>`
    : shown.map(({ s, d }, i) => `
      <button class="qrow" data-at="${i}"
              title="${s.osm ? `Open ${esc(s.osmId || "it")} on OpenStreetMap` : "Map this site"}">
        <span class="num">${iso(d).slice(5)}</span>
        <span class="q-net">${brandMark(s.net)}<span>${esc(s.net)}</span></span>
        <span class="q-name">${esc(s.name || "—")}</span>
        <span class="code">${esc(s.state || "—")}</span>
        <span class="num q-ports">${nf(s.ports || 0)} pt</span>
        ${s.osm ? `<span class="st st--on">On map ${out}</span>`
                : `<span class="st st--off">Missing ${go}</span>`}
      </button>`).join("");

  /* Every row goes somewhere: an unmapped site opens the editor standing on it,
     a mapped one opens what OpenStreetMap already holds. */
  for (const b of host.querySelectorAll("[data-at]")) {
    b.onclick = () => openSite(rows[Number(b.dataset.at)]?.s);
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
      `Showing the ${shown.length} networks with ${TABLE_MIN_PORTS}+ ${MERGED.l2 ? "" : "DC "}ports. ` +
      `The other ${hidden} operators (${nf(hiddenSites)} sites, ${nf(hiddenPorts)} ports) are counted in every ` +
      `figure on this page but omitted here.`;
  }
  shown.forEach(([net], i) => {
    const e = stat.get(net);
    const [spider, state] = SPIDERS[net] || [];
    /* Said in words as well as a dot: "broken" and "ok" were told apart by
       colour alone, which is no help to the one reader in twelve who cannot. */
    const dot = spider
      ? `<span class="spider" title="${esc(spider)} (${state})"><i class="dot dot--${state === "ok" ? "ok" : "bad"}"></i>${state === "ok" ? "ok" : "broken"}</span>`
      : `<span class="spider" title="no spider"><i class="dot dot--none"></i>none</span>`;
    const share = (e.m / e.n) * 100;
    const tr = el("tr");
    tr.innerHTML =
      `<td><span class="rank num">${String(i + 1).padStart(2, "0")}</span>${brandMark(net)}${esc(net)}</td>` +
      `<td class="num" data-v="${e.n}">${nf(e.n)}</td>` +
      `<td class="num" data-v="${e.p}">${nf(e.p)}</td>` +
      `<td class="num" data-v="${(e.p / e.n).toFixed(3)}">${(e.p / e.n).toFixed(1)}</td>` +
      `<td class="num" data-v="${(e.m / e.n).toFixed(4)}"><span class="cov">` +
        `<span class="cov-track"><span style="width:${share.toFixed(1)}%"></span></span>${share.toFixed(0)}%</span></td>` +
      `<td class="mono">${esc(SRC_SHORT[e.src] || e.src)}</td>` +
      `<td data-v="${spider ? (state === "ok" ? 2 : 1) : 0}">${dot}</td>`;
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
    RAW = { afdc, tesla, ea, ionna, osm, l2: fresh ? null : RAW?.l2 || null };
    /* Level 2 only if it was left switched on. It is 20 MB the board does not
       otherwise need, and a miss — the file not published yet — must not take
       the fast-charging board down with it. */
    VIEW.l2 = !!store.get(K_L2);
    if (VIEW.l2 && !RAW.l2) RAW.l2 = await grab("/afdc-l2", fresh).catch(() => null);
    if (VIEW.l2 && !RAW.l2) VIEW.l2 = false;
    const merged = merge(afdc, tesla, ea, ionna, osm, VIEW.l2 ? RAW.l2 : null);
    MERGED = merged;
    ATLAS_DIRTY = true;
    initControls();              // populate the selector first, independent of render
    render(merged);
    if (rebuild) safe("refresh report", () => reportRefresh(rebuild, before, merged));
  } catch (e) {
    $("status").innerHTML = `<span class="chip" style="color:var(--miss)">error</span> ${esc(e.message)}`;
    const why =
      `<b>Could not load.</b> ${esc(e.message)}. Check that <span class="mono">DATA_ORIGIN</span> ` +
      `points at your deployed worker and that the worker has its <span class="mono">OVERPASS_KEY</span> secret set.`;
    $("dedupenote").innerHTML = why;
    /* Said at the top of the page as well. The method note is folded away, and
       a board of empty signs with the reason hidden inside a closed panel reads
       as a blank page rather than as a failure with a cause. */
    const bad = $("load-error");
    if (bad) { bad.innerHTML = why; bad.hidden = false; }
    const wait = $("map-wait");
    if (wait && !MERGED) wait.textContent = "No data to draw.";
  }
}

/* The source payloads as fetched, kept so that switching Level 2 on or off is
   a second merge rather than a second download. */
let RAW = null;
const K_L2 = "cb.level2";

/* Level 2 on or off. On fetches the payload the first time and merges again
   with it; off merges again without. The merge is redone rather than the
   sites filtered, because with Level 2 in, a network's posts are folded into
   its fast-charging site at the same address — the two results are not one a
   subset of the other. */
async function setLevel2(on) {
  const sw = $("l2-toggle");
  if (!RAW || sw?.disabled) return;
  if (sw) sw.disabled = true;
  try {
    if (on && !RAW.l2) {
      $("status").innerHTML = `<span class="pulse pulse--wait"></span><span>loading Level 2 stations</span>`;
      RAW.l2 = await grab("/afdc-l2").catch(() => null);
    }
    if (on && !RAW.l2) {
      $("status").innerHTML = `<span class="chip" style="color:var(--warn)">no Level 2 data</span> ` +
        `it has not been published yet — it arrives with the next daily refresh`;
      return;
    }
    VIEW.l2 = !!on;
    store.set(K_L2, VIEW.l2);
    $("status").innerHTML = `<span class="pulse pulse--wait"></span><span>${on ? "adding" : "removing"} Level 2</span>`;
    // let the status paint before a merge that takes a second or two
    await new Promise((r) => setTimeout(r, 30));
    MERGED = merge(RAW.afdc, RAW.tesla, RAW.ea, RAW.ionna, RAW.osm, VIEW.l2 ? RAW.l2 : null);
    ATLAS_DIRTY = true;
    // a network or state that exists only with Level 2 in cannot stay selected without it
    if (VIEW.net && !MERGED.sites.some((s) => s.net === VIEW.net)) VIEW.net = null;
    if (VIEW.state && !MERGED.sites.some((s) => s.state === VIEW.state)) VIEW.state = null;
    // a new merge is new site objects, which have not been told their county yet
    if (VIEW.state && COUNTIES[VIEW.state]) assignCounties(MERGED.sites, VIEW.state, COUNTIES[VIEW.state]);
    if (!VIEW.state) VIEW.county = null;
    initControls();
    render(MERGED);
  } finally {
    if (sw) sw.disabled = false;
  }
}

function initControls() {
  const sel = $("state-select");
  /* Listed by name, with the code after it: "MO" and "MS" are a coin toss for
     anyone who does not live in one of them. The value is still the code. */
  const states = [...new Set(MERGED.sites.map((s) => s.state).filter(Boolean))]
    .map((code) => [code, STATES?.[code]?.name || code])
    .sort((a, b) => a[1].localeCompare(b[1]));
  const open = new Set(MERGED.sites.filter((s) => !s.osm).map((s) => s.state));
  sel.innerHTML = `<option value="">Every state</option>` +
    states.map(([code, name]) =>
      `<option value="${esc(code)}">${esc(name === code ? code : `${name} (${code})`)}${
        open.has(code) ? "" : " — all mapped"}</option>`).join("");
  sel.value = VIEW.state || "";
  /* Still the one mechanism. The map's click and the ranked list both set this
     and fire change, so there is a single place that decides what "this state"
     means and a single repaint behind it. */
  sel.onchange = () => {
    VIEW.state = sel.value || null;
    VIEW.county = null;
    $("reset-view").hidden = !VIEW.state;
    ATLAS_DIRTY = true;
    render(MERGED);
    /* Counties after the first paint, so the state opens at once and the
       boundaries arrive a moment later rather than holding it up. */
    const st = VIEW.state;
    if (st) loadCounties(st).then((list) => {
      if (!list || VIEW.state !== st) return;
      assignCounties(MERGED.sites, st, list);
      ATLAS_DIRTY = true;
      render(MERGED);
    });
  };
  $("reset-view").onclick = () => { sel.value = ""; sel.onchange(); };
  const cc = $("county-clear");
  if (cc) cc.onclick = () => { VIEW.county = null; render(MERGED); };

  /* Assigned rather than added: this runs again on every refresh, and stacked
     listeners would repaint the board once per refresh on each click. */
  const clear = $("scope-clear");
  if (clear) clear.onclick = () => {
    VIEW.net = null;
    sel.value = "";
    sel.onchange();
  };
  const all = $("net-all");
  if (all) all.onclick = () => { VIEW.net = null; render(MERGED); };
  const netClear = $("net-clear");
  if (netClear) netClear.onclick = () => { VIEW.net = null; render(MERGED); };

  /* The pill names the network; the list is where one is chosen. Clicking the
     pill goes there, so it is never a label that looks like a control. */
  const chip = $("net-chip");
  if (chip) chip.onclick = () => {
    showBrowse("nets");
    $("browse")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    $("net-query")?.focus({ preventScroll: true });
  };
  for (const [id, tab] of [["tab-states", "states"], ["tab-nets", "nets"]]) {
    const b = $(id);
    if (b) b.onclick = () => showBrowse(tab);
  }
  showBrowse(VIEW.browse);
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
      const { code, county, site } = e.detail;
      /* A dot is a site, and opens: the editor where it is missing, its page
         on OpenStreetMap where it is mapped. This used to fall through to the
         state click below — the dot was inside the open state, so clicking it
         read as "this state again" and zoomed out. */
      if (site != null) { openSite(ATLAS_ROWS[site]); return; }
      if (county) {
        // the open county again zooms back out to its state, as a state does
        VIEW.county = county === VIEW.county ? null : county;
        render(MERGED);
        return;
      }
      if (VIEW.county && code === VIEW.state) { VIEW.county = null; render(MERGED); return; }
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

/* Which of the two lists the panel beside the map shows. On a wide screen
   both are visible and this changes nothing you can see — the stylesheet
   decides that, so there is no width for this to keep in step with. */
function showBrowse(tab) {
  VIEW.browse = tab === "nets" ? "nets" : "states";
  const host = $("browse");
  if (host) host.dataset.tab = VIEW.browse;
  for (const [id, t] of [["tab-states", "states"], ["tab-nets", "nets"]]) {
    const b = $(id);
    if (!b) continue;
    b.classList.toggle("is-on", t === VIEW.browse);
    b.setAttribute("aria-pressed", String(t === VIEW.browse));
  }
}

/* Day and night. With no stored choice the page follows the system and the
   stylesheet does that unaided; a click here pins the other one and remembers
   it. Either way the map is a canvas, painted from the tokens at the moment it
   was drawn, so it has to be told to draw again. */
const K_THEME = "cb.theme";
const themeNow = () =>
  document.documentElement.dataset.theme ||
  (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
function repaintForTheme() {
  $("atlas")?._queue?.();
}
function toggleTheme() {
  const next = themeNow() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  store.set(K_THEME, next);
  repaintForTheme();
}
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", repaintForTheme);

/* Bind defensively: a control removed from the markup must not take the page
   down at load. */
const on = (id, ev, fn) => { const n = $(id); if (n) n.addEventListener(ev, fn); };
on("export-missing", "click", downloadMissing);
on("theme-toggle", "click", toggleTheme);
on("l2-toggle", "click", () => setLevel2(!VIEW.l2));
on("refresh", "click", () => {
  const b = $("refresh");
  if (b) { b.classList.add("spin"); b.disabled = true; }
  // Re-poll every source, and in preview mode rebuild the saved payloads first,
  // so this answers "what does OpenStreetMap hold now" and not "what did it
  // hold when the page opened".
  load(true).finally(() => { if (b) { b.classList.remove("spin"); b.disabled = false; } });
});
load();
