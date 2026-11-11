/**
 * Charging-board data proxy (Cloudflare Worker).
 *
 * Two jobs:
 *   1. Keep the Overpass access key server-side. The browser never sees it.
 *   2. Slim the upstream payloads. AFDC is 65 MB raw and the All the Places
 *      Electrify America export is 16 MB; both come out of here under 2 MB.
 *
 * There is deliberately no pass-through for arbitrary Overpass QL. The routes
 * below are a fixed menu and the worker builds the query itself, so a leaked
 * worker URL cannot be turned into an open Overpass relay.
 *
 * Deploy:
 *   npx wrangler secret put OVERPASS_KEY     # the fm_comm_… value
 *   npx wrangler deploy
 */

const ROUTES = {
  "/osm": { ttl: 3600, fn: osm },
  "/afdc": { ttl: 21600, fn: afdc },
  // Level 2 only, and only asked for when the board's toggle is on. It is a
  // 220 MB upstream response; a Worker may well not have the memory for it,
  // which is why the published board reads the copy the refresh job saves.
  "/afdc-l2": { ttl: 86400, fn: afdcL2 },
  "/tesla": { ttl: 1800, fn: tesla },
  "/ea": { ttl: 86400, fn: (env) => atp(env, "electrify_america_us") },
  "/ionna": { ttl: 86400, fn: (env) => atp(env, "ionna_us") },
  "/imagery": { ttl: 86400, fn: imagery },
};

const ALLOWED_ORIGINS = null; // e.g. ["https://board.example.com"]; null = any origin

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") return new Response(null, { headers: cors(origin) });
    if (request.method !== "GET") return err(405, "GET only", origin);

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true, routes: Object.keys(ROUTES) }, origin, 60);
    }

    const route = ROUTES[url.pathname];
    if (!route) return err(404, `No such route. Try: ${Object.keys(ROUTES).join(", ")}`, origin);

    // Edge cache keyed on the path alone — every route is parameterless, so the
    // query string never changes the answer, only whether a stored one is used.
    const cache = caches.default;
    const cacheKey = new Request(new URL(url.pathname, url.origin).toString(), { method: "GET" });
    // `?fresh=1` skips the stored copy and re-polls upstream. It is what the
    // board's refresh button sends: without it a refresh re-reads whatever the
    // edge kept, so a mapper who has just uploaded a node can be shown an
    // hour-old answer and conclude their edit did not land.
    const forced = url.searchParams.has("fresh");
    const hit = forced ? null : await cache.match(cacheKey);
    if (hit) {
      const r = new Response(hit.body, hit);
      r.headers.set("X-Cache", "HIT");
      for (const [k, v] of Object.entries(cors(origin))) r.headers.set(k, v);
      return r;
    }

    let payload;
    try {
      payload = await route.fn(env);
    } catch (e) {
      return err(502, `Upstream failed: ${e.message}`, origin);
    }

    const res = json(payload, origin, route.ttl);
    res.headers.set("X-Cache", "MISS");
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  },
};

/* ------------------------------------------------------------------ sources */

// Every US charging station, not only those carrying DC fast socket tags.
// Filtering on socket tags in the query undercounts badly: OSM has ~13,500 US
// charging stations but only ~4,400 have any socket:* detail, so a socket-
// filtered query answers "mapped in detail", not "mapped at all". Both are
// interesting, so fetch everything and let the client separate the two tiers
// via the `dc` flag below.
// `bb` rather than `center`, because a charging station mapped as an area has a
// size and the client matches against it. A 168-stall site is 750 m across; its
// centre can sit further from the operator's own published coordinate than any
// sane matching radius, which reads as "not mapped" when it plainly is.
//
// Not `center bb`: Overpass honours only the last geometry mode given, so that
// returns bounds with no centre and every way and relation silently loses its
// position. One mode, and the centre is derived below — Overpass's `center` is
// the middle of the bounding box anyway, so nothing is lost by computing it.
//
// The second half of the union is a different question: `charging_station=yes`
// on something that is not a station — a dealership, a hotel — records that
// charging exists there without mapping it. The board needs those to tell a
// site nobody has touched from one whose charging is already written down on
// the business that hosts it; without them the second kind is counted as
// untouched for ever. They are split out below rather than mixed in, because
// everything downstream that reads `sites` means stations by it.
const OSM_QUERY = `[out:json][timeout:240];
area["ISO3166-1"="US"][admin_level=2]->.us;
(
  nwr["amenity"="charging_station"](area.us);
  nwr["charging_station"="yes"](area.us);
);
out bb tags;`;

const DC_SOCKETS = new Set(["type1_combo", "type2_combo", "nacs", "chademo", "tesla_supercharger"]);

async function osm(env) {
  if (!env.OVERPASS_KEY) throw new Error("OVERPASS_KEY secret is not set");
  const endpoint = `https://api.fairwaymapper.com/k/${env.OVERPASS_KEY}/api/interpreter`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ data: OSM_QUERY }),
  });
  if (!res.ok) throw new Error(`overpass ${res.status}`);
  const body = await res.json();
  return { ...splitOsm(body.elements), source: "OpenStreetMap via Overpass", license: "ODbL",
           generated: body.osm3s?.timestamp_osm_base ?? null };
}

/* Stations in `sites`, hosts in `hosts`. Exported because the local snapshot
   refresh runs this same file's slimming, and the split has to agree between
   the two or the preview and the deployed board disagree about what is mapped. */
function splitOsm(elements) {
  const all = elements.map(slimOsm).filter((s) => s.lat != null);
  return { sites: all.filter((s) => !s.host), hosts: all.filter((s) => s.host) };
}

function slimOsm(el) {
  const t = el.tags || {};
  const sockets = {};
  for (const [k, v] of Object.entries(t)) {
    const m = /^socket:([a-z0-9_]+)$/.exec(k);
    if (m && v !== "no") sockets[m[1]] = /^\d+$/.test(v) ? Number(v) : 1;
  }
  // Half the diagonal of the element's own bounding box, in metres: how far the
  // site reaches from the point we compare against. Zero for a node.
  const b = el.bounds;
  const ext = b
    ? Math.hypot((b.maxlat - b.minlat) * 111320,
                 (b.maxlon - b.minlon) * 111320 * Math.cos(((b.maxlat + b.minlat) / 2 * Math.PI) / 180)) / 2
    : 0;
  return {
    id: `${el.type[0]}${el.id}`,
    // nodes carry their own position; areas are placed at the middle of their
    // bounding box, which is what `out center` would have returned
    lat: el.lat ?? el.center?.lat ?? (b ? (b.minlat + b.maxlat) / 2 : null),
    lon: el.lon ?? el.center?.lon ?? (b ? (b.minlon + b.maxlon) / 2 : null),
    // omitted for nodes and anything under a metre — 12,000 zeroes is 100 kB of
    // nothing, and the client reads a missing extent as none
    ...(ext >= 1 ? { ext: Math.round(ext) } : {}),
    /* The AFDC station id, where a mapper has recorded one. Every other field
       here describes the element; this one names the record it answers, which
       is the only way the board can tie a site to its source outright instead
       of guessing from how close the two coordinates landed. Kept verbatim,
       semicolons and all — a mapper listing several ids on one station is
       saying the site covers all of them, and splitting that is the client's
       job. Omitted where absent: ~2,400 US elements carry it against 13,600
       stations, and the nulls would cost more than the values. */
    ...(t["ref:afdc"] ? { afdc: t["ref:afdc"] } : {}),
    /* supercharge.info's site id, the same idea for the one network AFDC is not
       the best source for. 2,929 US elements carry it against 2,543 for
       ref:afdc, and Superchargers are a third of everything the board tracks,
       so it answers for a slice ref:afdc never reaches. */
    ...(t["ref:supercharge_info"] ? { sc: t["ref:supercharge_info"] } : {}),
    /* Not a station: something else that says charging happens here. Set rather
       than filtered out, so one pass can sort both kinds — see splitOsm. An
       element that is a station *and* carries charging_station=yes is a station,
       which is what this test says. */
    ...(t.amenity === "charging_station" ? {} : { host: true }),
    name: t.name || t.operator || t.brand || null,
    brand: t.brand || t.operator || t.network || null,
    // kept apart from `brand` as well as folded into it, so anything grouping
    // stations by operator, brand or name can still tell the three apart once
    // `brand` has flattened them into one field
    operator: t.operator || null,
    capacity: t.capacity ? Number(t.capacity) : null,
    dc: Object.keys(sockets).some((s) => DC_SOCKETS.has(s)),
    sockets,
  };
}

/* AFDC lists every charging unit on a site — the physical pedestal — with its
   connector mix, port count and power. It publishes no positions, so this can
   never place anything; what it gives is how many units there are and what each
   one is, which is what someone about to draw charge points onto imagery needs
   to know before they start clicking, and what makes an aggregate `capacity`
   and `socket:*` on the station accurate rather than guessed.

   Collapsed to distinct kinds with a count: the largest site in the feed has
   432 units and they are 432 copies of two descriptions. Connectors reporting
   no ports are dropped — AFDC lists the full menu on every unit and zeroes the
   ones it does not have, so keeping them would say a site has eight connector
   types when it has one. */
function unitKinds(rows) {
  const by = new Map();
  for (const u of rows || []) {
    const conn = {}, pw = {};
    let kw = 0;
    for (const [k, v] of Object.entries(u.connectors || {})) {
      if (!(v?.port_count > 0)) continue;
      conn[k] = v.port_count;
      if (v.power_kw > 0) pw[k] = v.power_kw;
      if (v.power_kw > kw) kw = v.power_kw;
    }
    const names = Object.keys(conn).sort();
    if (!names.length) continue;
    /* Power is per connector, and it has to stay that way. One number per unit
       — the largest — was kept here before, which is right for a unit with one
       connector type and wrong for 2,966 of the rest: a twin-head cabinet
       offering CCS at 150 kW and CHAdeMO at 50 kW went downstream as "150 kW",
       and the editor then proposed `socket:chademo:output=150 kW`.

       `kw` is still written, as the unit's best figure, because a board built
       before `pw` existed reads only that. `pw` rides along on every unit with
       more than one connector type, and on a single-connector unit never: there
       `kw` already is the connector's own figure. That rule is what lets a
       reader tell the two payload shapes apart without a version stamp — a
       multi-connector unit with no `pw` can only be the old shape, where which
       connector the number belongs to is not known. */
    const same = names.length === 1;
    /* `lv` is the charging level, written only where it is not DC fast. It
       used to be left out altogether on the grounds that the connector says
       it — which holds for CCS and CHAdeMO and not for Tesla's plug: a NACS
       cable is a 250 kW Supercharger stall or an 11 kW wall connector in a
       hotel car park, and only the level tells them apart. Without it every
       Tesla destination charger read as fast charging. */
    const lv = u.charging_level === "dc_fast" || !u.charging_level ? null
      : u.charging_level === "1" ? 1 : 2;
    const key = `${lv ?? ""}|${names.map((k) => `${k}:${conn[k]}@${pw[k] ?? ""}`).join(",")}`;
    const hit = by.get(key);
    if (hit) { hit.n++; continue; }
    by.set(key, { n: 1, kw: kw || null, conn, ...(same ? {} : { pw }), ...(lv ? { lv } : {}) });
  }
  return [...by.values()].sort((a, b) => b.n - a.n);
}

/* Shape one AFDC record. Split from the fetch so the stress test can run the
   same slimming over a saved response instead of a second copy of it.

   The optional fields are everything AFDC says about a site beyond where it is
   and how many ports it has. They used to be dropped on the way in, which left
   the editor proposing a bare station where the source had hours, a price, the
   cards the reader takes and a line about which corner of the car park to look
   in. Each is written only where AFDC has a value, so the common case costs
   nothing. */
function slimAfdc(s) {
  const u = unitKinds(s.ev_charging_units);
  const opt = (k, v) => (v == null || v === "" ? {} : { [k]: v });
  return {
    id: s.id,
    net: s.ev_network,
    name: s.station_name,
    lat: s.latitude,
    lon: s.longitude,
    ports: s.ev_dc_fast_num || 0,
    state: s.state,
    city: s.city,
    street: s.street_address,
    open: s.open_date,
    conf: s.date_last_confirmed,
    fac: s.facility_type,
    conn: s.ev_connector_types || [],
    // omitted where the site has none worth stating, so 15,000 empty arrays
    // do not ride along in the payload
    ...(u.length ? { units: u } : {}),
    restricted: !!s.restricted_access,
    accessDetail: s.access_detail_code || null,
    ...opt("zip", s.zip),
    ...opt("hours", s.access_days_time),
    ...opt("price", s.ev_pricing),
    ...opt("cards", s.cards_accepted),
    // where on the property: "1st floor of parking garage", "by the service entrance"
    ...opt("dir", s.intersection_directions),
    /* How AFDC came by the coordinate. "GPS" is the norm and is left out; the
       other codes mean it was geocoded from the street address, which lands on
       the building or the kerb rather than the equipment — 1,018 sites, and the
       mapper should know before trusting the pin. */
    ...(s.geocode_status && s.geocode_status !== "GPS" ? { geo: s.geocode_status } : {}),
    // light-duty is the default and says nothing; MD and HD are worth a tag
    ...(s.maximum_vehicle_class && s.maximum_vehicle_class !== "LD" ? { cls: s.maximum_vehicle_class } : {}),
    /* The operator's own id for the site. For Electrify America it is the same
       number All the Places calls `ref`, so the two records can be paired
       outright instead of by which coordinates landed nearest — 1,196 of 1,227
       sites. Kept for that network alone: every other operator's id is either
       a UUID nothing else quotes or a number no second source shares, and
       11,000 of them would be a quarter of a megabyte of nothing. */
    ...(s.ev_network === "Electrify America" ? opt("nid", s.ev_network_ids?.station?.[0]) : {}),
  };
}

async function afdc(env) {
  const key = env.NLR_API_KEY || "DEMO_KEY";
  const url =
    "https://developer.nlr.gov/api/alt-fuel-stations/v1.json" +
    `?api_key=${encodeURIComponent(key)}&fuel_type=ELEC&ev_charging_level=dc_fast` +
    "&status=E&access=public&country=US&limit=all";
  const res = await fetch(url, { headers: { "User-Agent": "charge-board/1.0" } });
  if (!res.ok) throw new Error(`afdc ${res.status}`);
  const body = await res.json();
  return {
    source: "AFDC (US DOE / NLR)",
    generated: new Date().toISOString().slice(0, 10),
    records: body.fuel_stations.length,
    // access_code=public still lets through gated and key-only sites: AFDC marks
    // those with restricted_access, and access_detail_code carries the reason.
    sites: body.fuel_stations.map(slimAfdc),
  };
}

/* Level 2 stations: the same AFDC register, asked for the other level.

   69,000 records against 16,000, so this is a payload of its own that the
   board loads only when asked, and each record is cut down further than a
   fast-charging one — it is the difference between 15 MB and 30:

     no `conn`      the units already say which connectors there are
     no `conf`      it changes on most records every day, which would make the
                    daily commit of this file a full rewrite rather than a diff
     no `cards`     optional detail, and 70,000 copies of it
     no `ports`     a Level 2 record has no DC ports by definition
     `h: 1`         for the 57,000 records whose hours are exactly
                    "24 hours daily"; anything else keeps its own words

   A station with DC ports as well is left out: it is in the fast-charging
   payload already, with its Level 2 units listed on it. Sorted by id so that
   one day's file differs from the next only where AFDC changed. */
function slimAfdcL2(s) {
  const full = slimAfdc(s);
  const { conn, conf, cards, ports, restricted, accessDetail, hours, nid, ...rest } = full;
  return {
    ...rest,
    ...(restricted ? { restricted: true } : {}),
    ...(accessDetail ? { accessDetail } : {}),
    ...(hours === "24 hours daily" ? { h: 1 } : hours ? { hours } : {}),
  };
}

async function afdcL2(env) {
  const key = env.NLR_API_KEY || "DEMO_KEY";
  const url =
    "https://developer.nlr.gov/api/alt-fuel-stations/v1.json" +
    `?api_key=${encodeURIComponent(key)}&fuel_type=ELEC&ev_charging_level=2` +
    "&status=E&access=public&country=US&limit=all";
  const res = await fetch(url, { headers: { "User-Agent": "charge-board/1.0" } });
  if (!res.ok) throw new Error(`afdc level 2 ${res.status}`);
  const body = await res.json();
  return {
    source: "AFDC (US DOE / NLR) · Level 2",
    generated: new Date().toISOString().slice(0, 10),
    records: body.fuel_stations.length,
    sites: body.fuel_stations
      .filter((s) => !(s.ev_dc_fast_num > 0))
      .sort((a, b) => a.id - b.id)
      .map(slimAfdcL2),
  };
}

async function tesla(env) {
  const res = await fetch("https://supercharge.info/service/supercharge/allSites");
  if (!res.ok) throw new Error(`supercharge ${res.status}`);
  const body = await res.json();
  return {
    source: "supercharge.info",
    generated: new Date().toISOString().slice(0, 10),
    sites: body.filter((s) => s.address?.country === "USA").map(slimTesla),
  };
}

function slimTesla(s) {
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    lat: s.gps.latitude,
    lon: s.gps.longitude,
    ports: s.stallCount,
    state: s.address.state,
    city: s.address.city,
    street: s.address.street,
    open: s.dateOpened || null,
    power: s.powerKilowatt || null,
    stalls: s.stalls || {},
    plugs: s.plugs || {},
    // Restrictions turn up in any of these three free-text fields.
    notes: [s.accessNotes, s.addressNotes, s.hours].filter(Boolean).join(" ") || null,
    ...(s.address.zip ? { zip: s.address.zip } : {}),
    // the business whose car park it is — the thing to look for on imagery
    ...(s.facilityName ? { host: s.facilityName } : {}),
    // which floor of the garage, which side of the building
    ...(s.addressNotes ? { dir: s.addressNotes } : {}),
    /* Whether other makes can charge here. False is a Tesla-only site; it is
       stated rather than left to be inferred from the plug list, because a
       NACS-only site can be open to anyone with an adapter. */
    ...(typeof s.otherEVs === "boolean" ? { other: s.otherEVs } : {}),
  };
}

// All the Places publishes weekly under a dated run id, so resolve it first.
/* Upstream having nothing to give is not the same as this code failing, and
   the two want different outcomes: one keeps yesterday's file and carries on,
   the other should stop and be looked at. Callers read `.soft` to tell them
   apart. */
const soft = (msg) => Object.assign(new Error(`atp ${msg}`), { soft: true });

async function atp(env, spider) {
  const latest = await fetch("https://data.alltheplaces.xyz/runs/latest.json");
  if (!latest.ok) throw new Error(`atp index ${latest.status}`);
  const { run_id } = await latest.json();
  const res = await fetch(
    `https://alltheplaces-data.openaddresses.io/runs/${run_id}/output/${spider}.geojson`
  );
  if (!res.ok) throw new Error(`atp ${spider} ${res.status}`);

  /* A run that produced nothing is served as 200 with an empty body, not as a
     404 — so `res.ok` passes and the parse yields null, and reading `.features`
     off it threw a TypeError naming an internal variable. That is upstream
     having no answer this week, not this code being broken, so it is marked
     `soft`: the caller keeps the file it already has and says so, rather than
     failing the run and stopping everything downstream with it.

     Read as text first. `res.json()` on an empty body is not portable — it
     throws in some runtimes and returns null in others — and the distinction
     between "published nothing" and "published something unreadable" is worth
     keeping, because only the first is normal. */
  const text = await res.text();
  if (!text.trim()) throw soft(`${spider}: run ${run_id} published an empty file`);
  let body;
  try { body = JSON.parse(text); }
  catch { throw new Error(`atp ${spider}: run ${run_id} output is not JSON`); }
  if (!Array.isArray(body?.features)) {
    throw soft(`${spider}: run ${run_id} output has no features`);
  }
  return {
    source: `All the Places · ${spider}`,
    run: run_id,
    sites: body.features.map(slimAtp),
  };
}

function slimAtp(f) {
  const p = f.properties;
  const sockets = {}, out = {}, amp = {}, volt = {}, vague = [];
  const num = (v) => { const n = parseFloat(String(v)); return n > 0 ? n : null; };
  for (const [k, v] of Object.entries(p)) {
    const m = /^socket:([a-z0-9_]+)(?::(output|current|voltage))?$/.exec(k);
    if (!m) continue;
    if (!m[2]) {
      if (v === "no") continue;
      const counted = /^\d+$/.test(String(v));
      sockets[m[1]] = counted ? Number(v) : 1;
      /* `yes` says the connector is there and nothing about how many. It is
         still stored as 1 — a board that predates this reads only `sockets` —
         but named here, so a reader that knows the difference does not mistake
         "present" for "exactly one". Electrify America's posts are all of this
         kind, and most of them carry two CCS cables. */
      if (!counted) vague.push(m[1]);
    } else {
      const n = num(v);
      if (n) ({ output: out, current: amp, voltage: volt })[m[2]][m[1]] = n;
    }
  }
  const has = (o) => Object.keys(o).length > 0;
  const opt = (k, v) => (v == null || v === "" ? {} : { [k]: v });
  return {
    ref: p.ref,
    kind: p.amenity === "charging_station" ? "site" : "point",
    name: p.name || p.branch || null,
    lat: f.geometry?.coordinates?.[1] ?? null,
    lon: f.geometry?.coordinates?.[0] ?? null,
    state: p["addr:state"] || null,
    city: p["addr:city"] || null,
    capacity: p.capacity ? Number(p.capacity) : null,
    access: p.access || null,
    sockets,
    /* What each connector delivers, where the operator publishes it. The
       station's own page is the best source there is for this — it is what the
       unit is configured to — and it was being parsed off and thrown away. */
    ...(has(out) ? { out } : {}),
    ...(has(amp) ? { amp } : {}),
    ...(has(volt) ? { volt } : {}),
    ...(vague.length ? { vague } : {}),
    // on the site only: every one of its charge points repeats the same address
    ...(p.amenity === "charging_station"
      ? { ...opt("street", p["addr:street_address"]), ...opt("zip", p["addr:postcode"]) } : {}),
    // the operator's page for this one site, not its home page
    ...opt("web", p.website),
    ...opt("fee", p.fee),
    ...opt("pfee", p["parking:fee"]),
    ...opt("hours", p.opening_hours),
  };
}

// Editor Layer Index — the aerial imagery catalogue every OSM editor picks from.
// The published index is 6.6 MB of every layer on earth, including historic
// scans, elevation and QA overlays. The placement editor only ever draws US
// aerial photography, so drop the rest and keep the fields the tile builder
// reads. Comes out near 1.1 MB. Geometry is kept in full: coverage polygons are
// what decide which layer is offered at a point, and a bounding box would offer
// a county ortho three counties away.
const ELI_URL = "https://osmlab.github.io/editor-layer-index/imagery.geojson";

async function imagery() {
  const res = await fetch(ELI_URL, { headers: { "User-Agent": "charge-board/1.0" } });
  if (!res.ok) throw new Error(`eli ${res.status}`);
  const body = await res.json();
  const layers = body.features.map(slimEli).filter(Boolean);
  return {
    source: "Editor Layer Index",
    license: "CC0",
    generated: new Date().toISOString().slice(0, 10),
    layers,
  };
}

function slimEli(f) {
  const p = f.properties || {};
  if (p.overlay) return null;
  // wmts needs a capabilities round-trip to resolve a tile URL; bing needs a
  // metadata call and a key. Neither is worth carrying for a browser editor.
  if (p.type !== "tms" && p.type !== "wms") return null;
  if (p.category !== "photo" && p.category !== "historicphoto") return null;
  if (p.country_code && p.country_code !== "US") return null;
  if (/{apikey}/i.test(p.url)) return null; // no key to hand it
  if (p.type === "wms" && p.available_projections &&
      !p.available_projections.some((x) => /3857|900913/.test(x))) return null;
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    url: p.url,
    min: p.min_zoom ?? 0,
    max: p.max_zoom ?? 19,
    start: p.start_date ?? null,
    end: p.end_date ?? null,
    best: !!p.best,
    attr: p.attribution?.text ?? null,
    attrUrl: p.attribution?.url ?? null,
    geom: f.geometry ?? null,
  };
}

/* ------------------------------------------------------------------ helpers */

function cors(origin) {
  const allow =
    ALLOWED_ORIGINS === null ? "*" : ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(obj, origin, ttl) {
  return new Response(JSON.stringify(obj), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${ttl}`,
      ...cors(origin),
    },
  });
}

function err(status, message, origin) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", ...cors(origin) },
  });
}

export { slimOsm, splitOsm, slimEli, slimAfdc, slimAfdcL2, slimTesla, slimAtp, unitKinds };
