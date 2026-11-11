/* Stress test: run the board's own merge, inventory and tag proposals over
   every site in the saved payloads, and check that what would be written to
   OpenStreetMap is internally consistent.

     bun tools/stress.js                 against data/
     bun tools/stress.js --data=DIR      against another directory of payloads
     bun tools/stress.js --verbose       list every example, not the first few
     bun tools/stress.js --l2            with the Level 2 switch on (needs afdc-l2.json)

   (node works too.) Exits 1 if any invariant fails.

   This runs the code the page runs — site-keys.js, app.js and edit.js are
   loaded as they are, into a sandbox with a stand-in for the DOM — rather than
   a copy of the logic, because a test of a copy passes while the page is wrong.
   The page's `load()` does the fetching and merging; this just hands it files
   instead of a network, waits, and then walks `MERGED.sites`.

   What it checks is the arithmetic a mapper cannot see from the panel: that a
   site's capacity is its ports and not its cables, that the sockets proposed
   add up to the dispensers offered for placing, that no output is quoted that
   no source stated, that nothing is written as "null" or as a date a hundred
   sites share. What it reports, without failing, is where sources disagree —
   those are not bugs, they are the cases the editor has to show rather than
   hide, and the counts say how common each is. */
import { readFileSync, existsSync } from "fs";
import vm from "vm";

const ROOT = new URL("..", import.meta.url).pathname;
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const DATA = arg("data") || `${ROOT}data`;
const VERBOSE = process.argv.includes("--verbose");
const WITH_L2 = process.argv.includes("--l2");

/* ------------------------------------------------------------ the sandbox */

/* Anything the page reaches for on the DOM gets one of these: an object that
   answers every property with another of itself, can be called, iterates as
   empty and prints as "". Rendering runs to completion against it and draws
   nothing, which is all a test of the logic underneath wants. */
function fake() {
  const target = function () {};
  const own = {};
  return new Proxy(target, {
    get(_, k) {
      if (k === "then") return undefined;                 // not a promise
      if (k === Symbol.toPrimitive) return () => "";
      if (k === Symbol.iterator) return function* () {};
      if (k === "length") return 0;
      if (k in own) return own[k];
      return (own[k] = fake());
    },
    set(_, k, v) { own[k] = v; return true; },
    apply() { return fake(); },
    has() { return true; },
  });
}

const files = new Map();
const readData = (name) => {
  if (!files.has(name)) {
    const path = `${DATA}/${name}`;
    files.set(name, existsSync(path) ? readFileSync(path, "utf8") : null);
  }
  return files.get(name);
};

const memory = new Map();
// the board reads its Level 2 switch from here, exactly as a browser left on would
if (WITH_L2) memory.set("cb.level2", "true");
const sandbox = {
  console, URL, URLSearchParams, Blob, TextEncoder, setTimeout, clearTimeout, performance,
  crypto: globalThis.crypto,
  localStorage: {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => memory.set(k, String(v)),
    removeItem: (k) => memory.delete(k),
  },
  location: { href: "http://localhost/index.html", origin: "http://localhost", search: "" },
  document: fake(),
  matchMedia: () => ({ matches: true, addEventListener() {} }),
  requestAnimationFrame: () => 0,
  getComputedStyle: () => ({ getPropertyValue: () => "" }),
  addEventListener() {}, removeEventListener() {},
  fetch: async (url) => {
    const name = String(url).split("?")[0].split("/").pop();
    const body = readData(name);
    return body == null
      ? { ok: false, status: 404, json: async () => { throw new Error("missing"); } }
      : { ok: true, status: 200, json: async () => JSON.parse(body) };
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.window.DATA_ORIGIN = ".";
sandbox.window.DATA_SUFFIX = ".json";
vm.createContext(sandbox);

const src = (f) => readFileSync(`${ROOT}${f}`, "utf8");
/* One script, as the page has it: the three files are classic scripts sharing
   a scope, and `edit.js` reads app.js's top-level names directly. The line in
   the middle hands the test the handful of app.js internals it asks about. */
vm.runInContext(
  src("site-keys.js") + "\n" + src("app.js") + `
;window.__board = { merge, siteInventory, afdcKinds, kindLabel, siteBays, unitSockets,
                    missingGeoJSON, DC_SOCKET, get MERGED() { return MERGED; } };
` + src("edit.js"), sandbox, { filename: "board.js" });

const T = sandbox.window.__board;
const K = sandbox.window.OSMKit;
for (let i = 0; i < 600 && !T.MERGED; i++) await new Promise((r) => setTimeout(r, 50));
if (!T.MERGED) { console.error("the board never finished loading its data"); process.exit(1); }
if (WITH_L2 && !T.MERGED.l2) { console.error(`--l2 was asked for and ${DATA}/afdc-l2.json could not be loaded`); process.exit(1); }

/* --------------------------------------------------------------- reporting */

const failures = new Map(), notes = new Map();
const tally = (map, name, example) => {
  const e = map.get(name) || { n: 0, ex: [] };
  e.n++;
  if (example && (VERBOSE || e.ex.length < 4)) e.ex.push(example);
  map.set(name, e);
};
const fail = (name, example) => tally(failures, name, example);
const note = (name, example) => tally(notes, name, example);
const id = (s) => `${s.net} · ${s.name || "unnamed"} (${s.state || "?"})` +
  `${s.refs?.length ? ` afdc:${s.refs.join(";")}` : ""}${s.sc ? ` sc:${s.sc}` : ""}`;

/* ------------------------------------------------------------- unit tables */

/* The small parsers, against cases written out by hand. These are the places
   a free-text field from a source becomes an OSM value, so each wants its own
   list of what must and must not come out. */
const table = (name, fn, cases) => {
  for (const [input, want] of cases) {
    const got = fn(input);
    if (JSON.stringify(got) !== JSON.stringify(want))
      fail(`${name}: wrong answer`, `${JSON.stringify(input)} → ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
  }
};
if (K.parseHours) table("parseHours", K.parseHours, [
  ["24 hours daily", "24/7"],
  ["24 Hours Daily", "24/7"],
  ["24 hours daily. NACS partner enabled.", "24/7"],
  ["24 hours daily; pay lot", "24/7"],
  ["24 hours daily; parking permit required", "24/7"],
  ["Dealership business hours", null],
  ["Open to all EV drivers", null],
  ["Parking lot hours", null],
  ["Mon: 6:00am-10:00pm; Tue: 6:00am-10:00pm; Wed: 6:00am-10:00pm; Thu: 6:00am-10:00pm; Fri: 6:00am-10:00pm; Sat: 6:00am-10:00pm; Sun: 6:00am-10:00pm", "Mo-Su 06:00-22:00"],
  ["Mon: 8:00am-7:00pm; Tue: 8:00am-7:00pm; Wed: 8:00am-7:00pm; Thu: 8:00am-7:00pm; Fri: 8:00am-7:00pm; Sat: 9:00am-5:00pm; Sun: 9:00am-5:00pm", "Mo-Fr 08:00-19:00; Sa-Su 09:00-17:00"],
  ["Mon: 12:00am-11:59pm; Tue: 12:00am-11:59pm; Wed: 12:00am-11:59pm; Thu: 12:00am-11:59pm; Fri: 12:00am-11:59pm; Sat: 12:00am-11:59pm; Sun: 12:00am-11:59pm", "24/7"],
  ["Mon: 7:00am-7:00pm; Tue: 7:00am-7:00pm", "Mo-Tu 07:00-19:00"],
  ["Mon: 12:00am-4:00pm, 8:00pm-11:59pm; Tue: 12:00am-4:00pm, 8:00pm-11:59pm", "Mo-Tu 00:00-16:00,20:00-24:00"],
  // a tariff schedule filed as hours: back-to-back periods are one period
  ["Mon: 12:01am-7:59am, 8:00am-9:00am, 9:01am-11:59pm; Tue: 12:00am-11:59pm", "Mo-Tu 00:00-24:00"],
  ["Mon: 6:00am-9:00am, 5:00pm-10:00pm", "Mo 06:00-09:00,17:00-22:00"],     // a real gap is kept
  ["6:00am-12:00am daily. Open to Teslas only.", "Mo-Su 06:00-24:00"],
  ["5am-10pm daily", "Mo-Su 05:00-22:00"],
  ["9am-5pm M-F", null],
  ["Mon: 6:00am-10:00pm; closed Tue", null],                                // one part unreadable, none used
  ["", null], [null, null], ["7am-10pm", null],
]);
if (K.parsePrice) table("parsePrice", K.parsePrice, [
  ["Free", { fee: "no" }],
  ["free", { fee: "no" }],
  // a price is `fee=yes` and nothing more: `charge` is not written (see parsePrice)
  ["$0.30 per kWh", { fee: "yes" }],
  ["$0.25 per minute", { fee: "yes" }],
  ["$0.40/kwh", { fee: "yes" }],
  ["Dynamic EV pricing rates", { fee: "yes" }],
  ["Please download 7Charge app for current pricing.", { fee: "yes" }],
  ["$0.48 per kWh; $1.00 per session", { fee: "yes" }],
  ["Free for first hour; $2.00 per hour after", null],     // two statements, not one price
  ["Free; pay lot", { fee: "no", "parking:fee": "yes" }],
  ["Level 2 Free; DC Fast Charger $10 per hour", null],
  ["Donations accepted", null],
  ["", null], [null, null],
]);
if (K.startDate) table("startDate", (a) => K.startDate(...a), [
  [["2024-04-09", 0], "2024-04-09"],
  [["2019-01-01", 0], "2019"],              // a year, not the first of January
  [["2021-01-27", 247], null],              // a batch load, not an opening
  [["", 0], null], [[null, 0], null], [["2024-13-40", 0], null], [["20240409", 0], null],
]);
if (K.expandStreet) table("expandStreet", K.expandStreet, [
  ["3010 Potato Rd", { housenumber: "3010", street: "Potato Road" }],
  ["850 N Broadway", { housenumber: "850", street: "North Broadway" }],
  ["4 Fisher St", { housenumber: "4", street: "Fisher Street" }],
  ["1041 Grass Valley Road", { housenumber: "1041", street: "Grass Valley Road" }],
  ["100 St Charles Ave", { housenumber: "100", street: "St Charles Avenue" }],     // Saint, left alone
  ["12345 US Hwy 19 N", { housenumber: "12345", street: "US Highway 19 North" }],
  ["2402 Highway 31 S", { housenumber: "2402", street: "Highway 31 South" }],
  ["1400 Route 22", { housenumber: "1400", street: "Route 22" }],
  ["63 Rd 1", { housenumber: "63", street: "Road 1" }],
  ["700 Ave K", { housenumber: "700", street: "Avenue K" }],
  ["955 N 400 E", { housenumber: "955", street: "North 400 East" }],              // a Utah grid address
  ["1200 N St NW", { housenumber: "1200", street: "N Street Northwest" }],        // the street called N
  ["5650 S I-35 E", { housenumber: "5650", street: "South I-35 E" }],             // I-35E keeps its letter
  ["33180 OR-228", { housenumber: "33180", street: "OR-228" }],
  ["123 MAIN ST", { housenumber: "123", street: "Main Street" }],
  // the street stops at its type word; what follows is where on the property
  ["555 W 44th St PUBLIC WORKS", { housenumber: "555", street: "West 44th Street", extra: "PUBLIC WORKS" }],
  ["1 Town Square Murrieta City Hall", { housenumber: "1", street: "Town Square", extra: "Murrieta City Hall" }],
  ["400 S Flower St P7 TWIN TOWERS", { housenumber: "400", street: "South Flower Street", extra: "P7 TWIN TOWERS" }],
  ["12 Main St Ste 100", { housenumber: "12", street: "Main Street", extra: "Ste 100" }],
  ["12 Main St, Suite 100", { housenumber: "12", street: "Main Street", extra: "Suite 100" }],
  ["90 Park Ave South Garage Level 2", { housenumber: "90", street: "Park Avenue", extra: "South Garage Level 2" }],
  ["90 Park Ave South", { housenumber: "90", street: "Park Avenue South" }],
  ["90 Park Ave S Garage Level 2", { housenumber: "90", street: "Park Avenue South", extra: "Garage Level 2" }],
  ["2229 E EXPY 83", { housenumber: "2229", street: "East Expressway 83" }],
  ["204 Wade Rd Extension", { housenumber: "204", street: "Wade Road Extension" }],
  ["1943 Montague Ave Ext", { housenumber: "1943", street: "Montague Avenue Extension" }],
  ["235 State Hwy 7 Frontage Rd", { housenumber: "235", street: "State Highway 7 Frontage Road" }],
  ["12881 Farm to Market Road 14 A", { housenumber: "12881", street: "Farm to Market Road 14", extra: "A" }],
  ["500 Oracle Pkwy 500 Oracle Pkwy", { housenumber: "500", street: "Oracle Parkway", extra: "500 Oracle Pkwy" }],
  ["10 Mill Rd Shopping Plaza", { housenumber: "10", street: "Mill Road", extra: "Shopping Plaza" }],
  ["10 Main St Court House", { housenumber: "10", street: "Main Street", extra: "Court House" }],
  // the same words as names, which must not be cut
  ["12 Fox Run Dr", { housenumber: "12", street: "Fox Run Drive" }],
  ["8 E St Charles Rd", { housenumber: "8", street: "East St Charles Road" }],
  ["3 Court House Dr", { housenumber: "3", street: "Court House Drive" }],
  ["27 Drive Thru Tree Rd", { housenumber: "27", street: "Drive Thru Tree Road" }],
  ["400 Avenue of the Cities", { housenumber: "400", street: "Avenue of the Cities" }],
  ["5 State Road 33 N", { housenumber: "5", street: "State Road 33 North" }],
  ["9 County Road B W", { housenumber: "9", street: "County Road B West" }],
  ["17503 N Loop 1604 W", { housenumber: "17503", street: "North Loop 1604 West" }],
  ["615 615 second Ave east", { housenumber: "615", street: "Second Avenue East" }],
  ["1 Jaguar Land Rover Wy DC CHARGER North Parking", { housenumber: "1", street: "Jaguar Land Rover Way", extra: "DC CHARGER North Parking" }],
  ["950 N BALDWIN Ave", { housenumber: "950", street: "North Baldwin Avenue" }],
  ["1 IKEA Way", { housenumber: "1", street: "IKEA Way" }],                        // spelled so on the sign
  ["I-95 Exit 12", null],                      // not an address
  ["Hwy 55 & Main St", null],                  // an intersection
  ["100 Main St at 5th Ave", null],
  ["", null], [null, null],
]);

/* ----------------------------------------------------------- every site */

const M = T.MERGED;
const INT = /^[1-9]\d*$/;
const KW = /^\d+(\.\d+)? kW$/;
const BAD = new Set(["null", "undefined", "nan", ""]);
const sum = (a) => a.reduce((x, y) => x + y, 0);
const split = (v) => String(v).split(";");

let proposed = 0;
const tagUse = new Map();

for (const s of M.sites) {
  const inv = T.siteInventory(s);

  /* ---- the inventory against itself ---- */
  const bays = sum(inv.kinds.map((k) => k.n));
  if (inv.kinds.length && inv.capacity !== bays) fail("inventory: capacity is not the sum of its ports", id(s));
  for (const k of inv.kinds) {
    if (!Number.isInteger(k.n) || k.n < 1) fail("inventory: a kind with no ports", id(s));
    for (const [t, c] of Object.entries(k.conn)) {
      if (!Number.isInteger(c) || c < 1) fail("inventory: a connector count that is not a whole number", `${id(s)} ${t}=${c}`);
      const p = k.kw?.[t];
      if (p != null && !(p > 0 && p <= 1500)) fail("inventory: an implausible power", `${id(s)} ${t}=${p}`);
    }
  }
  for (const [t, e] of Object.entries(inv.sockets)) {
    if (e.n == null) continue;
    if (sum(e.powers.map(([, c]) => c)) + e.unknown !== e.n)
      fail("inventory: power buckets do not add up to the cables", `${id(s)} ${t}`);
  }
  if (inv.kinds.length && inv.capacity > sum(Object.values(inv.sockets).map((e) => e.n || 0)))
    fail("inventory: more ports than cables", id(s));

  /* ---- sources against each other: reported, not failed ---- */
  if (!inv.agree) note("sources disagree on the port count",
    `${id(s)} — ${inv.claims.map((c) => `${c.src} ${c.n}`).join(" vs ")}`);
  if (s.portsSrc === "AFDC") note("port count taken from AFDC because the better source had none", id(s));
  if (s.portsUnknown && !s.portsSrc) note("no source counts the ports", id(s));
  if (!inv.kinds.length) note("no dispenser kinds (totals only)", id(s));
  if (Object.values(inv.sockets).some((e) => e.powers.length > 1)) note("power varies within a connector type", id(s));
  if (Object.entries(inv.sockets).some(([t, e]) => inv.kinds.some((k) => k.dc && k.conn[t]) && e.n && e.unknown === e.n))
    note("a DC connector with no stated power", id(s));
  if (inv.kinds.some((k) => Object.values(k.conn).some((c) => c > 1))) note("two cables of one type on one port", id(s));
  if (inv.kinds.some((k) => k.vague)) note("connector counts are presence only", id(s));
  if (inv.kinds.some((k) => k.mixed)) note("mixed Supercharger generations: no per-stall power", id(s));
  /* A mixed site must not hand any port a power figure: that is the guess. */
  if (inv.src === "supercharge.info" && inv.kinds.some((k) => k.mixed && Object.keys(k.kw).length))
    fail("Tesla: a mixed-generation site gave a port a power figure", id(s));
  if (s.openBulk) note("open date is a batch-load date", `${id(s)} — ${s.open} ×${s.openBulk}`);
  if (s.geo) note("position geocoded from the address", id(s));
  if (inv.flags.some((f) => /share an address/.test(f.text))) note("records joined by address stand far apart", id(s));
  if ((s.pins || []).some((p) => Math.hypot((p.lat - s.lat) * 111320, (p.lon - s.lon) * 111320 * Math.cos(s.lat * Math.PI / 180)) > 2100))
    fail("merge: records more than 2 km apart collapsed into one site", id(s));

  /* ---- the inventory against the payload, without going through it ----

     The checks above compare the board with itself, and a mistake in how the
     payload is read would pass every one of them: wrong in the inventory,
     wrong in the proposal, and consistent. So the raw unit rows are added up
     here by a second, deliberately plain reading — this file's own connector
     table, no shared helpers — and the two have to agree. */
  if (inv.src === "AFDC" && s.units?.length) {
    const RAW = { J1772COMBO: "type1_combo", CHADEMO: "chademo", TESLA: "nacs", J3271: "nacs",
                  J1772: "type1", NEMA515: "nema_5_15", NEMA520: "nema_5_20", NEMA1450: "nema_14_50" };
    let ports = 0;
    const cables = {}, powers = {};
    for (const u of s.units) {
      const names = Object.keys(u.conn || {});
      if (!names.some((k) => RAW[k])) continue;
      ports += u.n;
      for (const k of names) {
        const t = RAW[k];
        if (!t) continue;
        cables[t] = (cables[t] || 0) + u.n * u.conn[k];
        // a figure is this connector's own only if the payload says so
        const p = u.pw ? u.pw[k] : names.length === 1 ? u.kw : null;
        if (p > 0) (powers[t] ||= new Set()).add(p);
      }
    }
    const paired = s.src !== "AFDC";          // AFDC's breakdown on another source's site
    if (!paired && inv.capacity !== ports) fail("payload: capacity is not the number of AFDC units", `${id(s)} ${inv.capacity} vs ${ports}`);
    for (const [t, e] of Object.entries(inv.sockets)) {
      if (!paired && e.n !== (cables[t] || 0)) fail("payload: cable count differs from the AFDC units", `${id(s)} ${t} ${e.n} vs ${cables[t]}`);
      if (paired) continue;
      for (const [kw] of e.powers) if (!powers[t]?.has(kw))
        fail("payload: a power AFDC did not give for that connector", `${id(s)} ${t} ${kw} kW (AFDC: ${[...(powers[t] || [])].join("/") || "none"})`);
    }
  }
  if (/supercharge/.test(s.src) && inv.src === "supercharge.info" && inv.capacity !== s.ports)
    fail("payload: Supercharger capacity is not the stall count", `${id(s)} ${inv.capacity} vs ${s.ports}`);

  /* Tesla's own arithmetic: every stall has a NACS cable. */
  if (/supercharge/.test(s.src) && inv.src === "supercharge.info" && inv.sockets.nacs?.n !== s.ports)
    fail("Tesla: NACS sockets differ from the stall count", `${id(s)} nacs=${inv.sockets.nacs?.n} stalls=${s.ports}`);

  if (!K.proposeTags) continue;

  /* ---- what the single-node card would write ---- */
  const tags = K.cleanTags(K.proposeTags(s));
  proposed++;
  for (const k of Object.keys(tags)) tagUse.set(k.replace(/^socket:[a-z0-9_]+/, "socket:*"), (tagUse.get(k.replace(/^socket:[a-z0-9_]+/, "socket:*")) || 0) + 1);

  if (tags.amenity !== "charging_station") fail("proposal: not a charging station", id(s));
  for (const [k, v] of Object.entries(tags)) {
    if (BAD.has(String(v).trim().toLowerCase())) fail("proposal: an empty or null value", `${id(s)} ${k}=${v}`);
    if (String(v).length > 255) fail("proposal: a value longer than OSM allows", `${id(s)} ${k}`);
    if (/[\n\r\t]/.test(v)) fail("proposal: a control character in a value", `${id(s)} ${k}`);
  }
  if (tags.capacity != null) {
    if (!INT.test(tags.capacity)) fail("proposal: capacity is not a positive whole number", `${id(s)} ${tags.capacity}`);
    else if (inv.capacity != null && Number(tags.capacity) !== inv.capacity)
      fail("proposal: capacity differs from the inventory", `${id(s)} ${tags.capacity} vs ${inv.capacity}`);
  } else if (inv.capacity != null) fail("proposal: capacity known and not proposed", id(s));

  let cables = 0, counted = true;
  for (const [k, v] of Object.entries(tags)) {
    const m = /^socket:([a-z0-9_]+)$/.exec(k);
    if (!m) continue;
    if (v === "yes") { counted = false; continue; }
    const parts = split(v);
    if (!parts.every((x) => INT.test(x))) { fail("proposal: a socket count that is not a number", `${id(s)} ${k}=${v}`); continue; }
    const n = sum(parts.map(Number));
    cables += n;
    if (inv.sockets[m[1]]?.n != null && inv.sockets[m[1]].n !== n)
      fail("proposal: socket count differs from the inventory", `${id(s)} ${k}=${v} vs ${inv.sockets[m[1]].n}`);
    const out = tags[`${k}:output`];
    if (out != null) {
      const outs = split(out);
      if (!outs.every((x) => KW.test(x))) fail("proposal: an output that is not '<n> kW'", `${id(s)} ${k}:output=${out}`);
      if (outs.length !== 1 && outs.length !== parts.length)
        fail("proposal: split output and split count are different lengths", `${id(s)} ${k}=${v} / ${out}`);
      /* The central one. An output may only be a figure some source gave for
         that connector at this site — never one borrowed from the connector
         beside it. */
      const stated = new Set((inv.sockets[m[1]]?.powers || []).map(([kw]) => kw));
      if (inv.sockets[m[1]]?.peak) stated.add(inv.sockets[m[1]].peak);   // a mixed site's fastest stall
      for (const x of outs) if (!stated.has(parseFloat(x)))
        fail("proposal: an output no source stated for that connector", `${id(s)} ${k}:output=${out}`);
    }
  }
  for (const k of Object.keys(tags)) {
    const m = /^(socket:[a-z0-9_]+):(output|current|voltage)$/.exec(k);
    if (m && tags[m[1]] == null) fail("proposal: a socket detail with no socket", `${id(s)} ${k}`);
  }
  if (counted && tags.capacity && cables && Number(tags.capacity) > cables)
    fail("proposal: capacity exceeds the sockets proposed", `${id(s)} capacity=${tags.capacity} sockets=${cables}`);
  if (tags.frequency === "0" && inv.kinds.some((k) => !k.dc))
    fail("proposal: frequency=0 on a site with AC ports", id(s));
  if (tags.frequency === "60" && inv.kinds.some((k) => k.dc))
    fail("proposal: frequency=60 on a site with DC ports", id(s));
  if (inv.kinds.length && inv.kinds.every((k) => !k.dc) && tags.frequency !== "60")
    fail("proposal: an all-AC site without frequency=60", id(s));
  /* Level 2 sites are AC by definition, whatever plug they carry. This is the
     check a Tesla destination charger fails if its NACS cable is read as a
     Supercharger's. Read off the raw units, not the inventory. */
  if (s.l2) {
    if (inv.kinds.some((k) => k.dc)) fail("level 2: a site with no DC port has a DC kind", id(s));
    if ((s.units || []).some((u) => !u.lv)) fail("level 2: a unit with no charging level on a Level 2 site", id(s));
    if (tags.frequency === "0") fail("level 2: frequency=0 proposed", id(s));
  }
  if (!s.l2 && s.src === "AFDC" && !(s.units || []).some((u) => !u.lv) && (s.units || []).length && (s.units || []).some((u) => u.lv != null))
    fail("level 2: a site of Level 2 units only is counted as fast charging", id(s));
  if (tags.start_date) {
    if (!/^\d{4}(-\d{2}-\d{2})?$/.test(tags.start_date)) fail("proposal: start_date is not a date", `${id(s)} ${tags.start_date}`);
    if (s.openBulk) fail("proposal: a batch-load date written as start_date", `${id(s)} ${tags.start_date}`);
    if (tags.start_date > new Date().toISOString().slice(0, 10)) fail("proposal: start_date in the future", `${id(s)} ${tags.start_date}`);
  }
  if (tags["ref:afdc"] && !/^\d+(;\d+)*$/.test(tags["ref:afdc"])) fail("proposal: ref:afdc is not a list of ids", `${id(s)} ${tags["ref:afdc"]}`);
  if (tags.opening_hours && !/^(24\/7|((Mo|Tu|We|Th|Fr|Sa|Su)(-(Mo|Tu|We|Th|Fr|Sa|Su))?(,(Mo|Tu|We|Th|Fr|Sa|Su))* \d\d:\d\d-\d\d:\d\d(,\d\d:\d\d-\d\d:\d\d)*)(; (Mo|Tu|We|Th|Fr|Sa|Su)(-(Mo|Tu|We|Th|Fr|Sa|Su))?(,(Mo|Tu|We|Th|Fr|Sa|Su))* \d\d:\d\d-\d\d:\d\d(,\d\d:\d\d-\d\d:\d\d)*)*)$/.test(tags.opening_hours))
    fail("proposal: opening_hours is not valid syntax", `${id(s)} ${tags.opening_hours}`);
  if (tags.charge != null) fail("proposal: a `charge` tag, which is not to be written", `${id(s)} ${tags.charge}`);
  /* The address: a street that still carries an abbreviation at its end, or a
     word in capitals after its type, is the building's name riding along. */
  if (tags["addr:street"] != null) {
    if (!tags["addr:housenumber"]) fail("proposal: a street with no house number", id(s));
    if (/\b(St|Rd|Ave|Blvd|Dr|Ln|Ct|Pkwy|Hwy)$/.test(tags["addr:street"])) fail("proposal: a street left abbreviated", `${id(s)} ${tags["addr:street"]}`);
    if (tags["addr:street"].split(" ").includes(tags["addr:housenumber"])) fail("proposal: the house number repeated inside addr:street", `${id(s)} ${tags["addr:street"]}`);
    // a word in capitals is a label — "PUBLIC WORKS" — unless it is a highway or a compass point
    if (tags["addr:street"].split(" ").some((w) => /^[A-Z]{5,}$/.test(w)))
      fail("proposal: a word in capitals left in addr:street", `${id(s)} ${tags["addr:street"]}`);
  }
  if (tags["addr:postcode"] && !/^\d{5}(-\d{4})?$/.test(tags["addr:postcode"])) fail("proposal: a postcode that is not a ZIP", `${id(s)} ${tags["addr:postcode"]}`);
  if (tags["addr:state"] && !/^[A-Z]{2}$/.test(tags["addr:state"])) fail("proposal: a state that is not a code", `${id(s)} ${tags["addr:state"]}`);
  if (tags.fee && !/^(yes|no)$/.test(tags.fee)) fail("proposal: fee is not yes or no", `${id(s)} ${tags.fee}`);
  if (tags.website && !/^https?:\/\/\S+$/.test(tags.website)) fail("proposal: website is not a URL", `${id(s)} ${tags.website}`);

  /* ---- the optional extras, each as it would land if clicked ---- */
  for (const x of K.extraTags2?.(s) || []) {
    for (const [k, v] of Object.entries(x.tags)) {
      if (BAD.has(String(v).trim().toLowerCase())) fail("extra: an empty or null value", `${id(s)} ${k}=${v}`);
      if (k === "addr:postcode" && !/^\d{5}(-\d{4})?$/.test(v)) fail("extra: a postcode that is not a ZIP", `${id(s)} ${v}`);
      if (k === "addr:state" && !/^[A-Z]{2}$/.test(v)) fail("extra: a state that is not a code", `${id(s)} ${v}`);
      if (/^payment:/.test(k) && v !== "yes") fail("extra: a payment tag that is not yes", `${id(s)} ${k}=${v}`);
    }
  }

  /* ---- the area card: station totals, and the dispensers under them ---- */
  if (!inv.kinds.length) continue;
  const station = K.cleanTags(K.stationTags({ amenity: "charging_station" }, inv));
  if (Number(station.capacity) !== inv.capacity) fail("station: capacity differs from the inventory", id(s));
  const placed = {};
  let placedBays = 0;
  for (const kind of inv.kinds) {
    const pt = K.cleanTags(K.pointTags(K.kindCfg(kind)));
    if (pt.man_made !== "charge_point") fail("point: not a charge point", id(s));
    if (pt.capacity !== "1") fail("point: one port is not capacity 1", `${id(s)} ${pt.capacity}`);
    placedBays += kind.n * Number(pt.capacity);
    for (const [k, v] of Object.entries(pt)) {
      const m = /^socket:([a-z0-9_]+)$/.exec(k);
      if (m) placed[m[1]] = (placed[m[1]] || 0) + kind.n * Number(v);
      const o = /^socket:([a-z0-9_]+):output$/.exec(k);
      if (o && parseFloat(v) !== kind.kw[o[1]]) fail("point: output differs from its kind", `${id(s)} ${k}=${v}`);
      if (o && !KW.test(v)) fail("point: an output that is not '<n> kW'", `${id(s)} ${k}=${v}`);
    }
    if (pt.frequency === "0" && !kind.dc) fail("point: frequency=0 on an AC port", id(s));
    if (pt.frequency !== (kind.dc ? "0" : "60")) fail("point: frequency does not match the kind", `${id(s)} ${pt.frequency} dc=${kind.dc}`);
    // two ports on one cabinet is the same sockets twice and two cars
    const twin = K.cleanTags(K.pointTags(K.kindCfg(kind, 2)));
    if (twin.capacity !== "2") fail("point: two ports on a cabinet is not capacity 2", id(s));
    for (const [t, c] of Object.entries(kind.conn))
      if (Number(twin[`socket:${t}`]) !== 2 * c) fail("point: two ports do not double the sockets", `${id(s)} ${t}`);
  }
  /* The balance has to close: place every kind the panel offers and the
     sockets on the points equal the sockets on the station. If it does not,
     the mapper is left with a remainder nothing can account for. */
  if (placedBays !== inv.capacity) fail("balance: placing every kind does not reach the capacity", id(s));
  for (const [t, e] of Object.entries(inv.sockets)) {
    if ((placed[t] || 0) !== e.n) fail("balance: sockets on the points differ from the station's", `${id(s)} ${t} ${placed[t]} vs ${e.n}`);
    if (Number(sum(split(station[`socket:${t}`] || "0").map(Number))) !== e.n) fail("station: socket count differs from the inventory", `${id(s)} ${t}`);
  }
}

/* The export is the same facts in a file, so it gets the same two checks. */
const geo = T.missingGeoJSON(M.sites.filter((s) => !s.osm && s.lat != null).slice(0, 4000), "test");
for (const f of geo.features) {
  for (const [k, v] of Object.entries(f.properties)) {
    if (v != null && BAD.has(String(v).trim().toLowerCase())) fail("export: an empty or null string", `${f.properties.name} ${k}`);
  }
}

/* ------------------------------------------------------------------ result */

const line = (map) => [...map].sort((a, b) => b[1].n - a[1].n)
  .map(([name, e]) => `  ${String(e.n).padStart(6)}  ${name}${e.ex.length ? "\n" + e.ex.map((x) => `            ${x}`).join("\n") : ""}`).join("\n");

console.log(`${M.sites.length} sites from ${DATA}` +
  ` · AFDC units ${M.sites.some((s) => (s.units || []).some((u) => u.pw)) ? "carry per-connector power" : "carry one power per unit (older payload)"}`);
console.log(`${proposed} proposals checked${M.l2 ? ` · Level 2 on: ${M.l2Sites} Level 2 sites` : ""}\n`);
if (tagUse.size) console.log("tags proposed, by how many sites:\n  " +
  [...tagUse].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" · ") + "\n");
console.log("where the sources leave a judgement to the mapper:\n" + (line(notes) || "  nothing") + "\n");
if (failures.size) {
  console.log("FAILED\n" + line(failures));
  process.exit(1);
}
console.log("every invariant held");
