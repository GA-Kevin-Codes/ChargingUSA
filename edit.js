/* "Make improvements" — put the board's unmapped stations onto OpenStreetMap.

   The board already knows which sites nobody has mapped; this turns that list
   into a work queue. One site at a time: newest imagery for that spot, a pin to
   drop, the tags to confirm, then a changeset of its own. One node per
   changeset is deliberate — a changeset's bounding box is the box around
   everything in it, so batching a day of scattered placements into one produces
   a changeset the size of a state, which is unreviewable and undoable only as a
   block. Small changesets cost nothing and stay local.

   Everything here hangs off app.js's globals (MERGED, VIEW, $, el, nf, cssv,
   brandMark, sameBrand, render) and runs inside an IIFE so nothing collides with
   them. */

(() => {
"use strict";

const APP = "US Charging Board";
const VERSION = "1.0";

/* OSM runs two worlds: the live map, and a sandbox whose database is wiped
   periodically. Both are offered, each with its own client id and token, since
   an app registered on one is unknown to the other. Practise on the sandbox. */
const ENVS = {
  osm: { label: "OpenStreetMap (live)", web: "https://www.openstreetmap.org", api: "https://api.openstreetmap.org" },
  dev: { label: "Dev sandbox", web: "https://api06.dev.openstreetmap.org", api: "https://api06.dev.openstreetmap.org" },
};

const SCOPES = "read_prefs write_api";
const REDIRECT = new URL("osm-land.html", location.href).href;

/* --------------------------------------------------------------- persistence */

const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
};
const K = {
  env: "cb.osm.env",
  client: (e) => `cb.osm.${e}.client`,
  token: (e) => `cb.osm.${e}.token`,
  layer: "cb.improve.layer",
  pin: "cb.improve.pinLayer",
  done: "cb.improve.done",
  skip: "cb.improve.skip",
  mode: "cb.improve.mode",
  upDone: "cb.improve.up.done",
  upSkip: "cb.improve.up.skip",
  gear: "cb.improve.gear",
  models: "cb.improve.models",
  wikidata: "cb.improve.wikidata",
};

const envKey = () => (store.get(K.env) === "dev" ? "dev" : "osm");
const ENV = () => ENVS[envKey()];
const clientId = () => store.get(K.client(envKey())) || (envKey() === "osm" ? window.OSM_CLIENT_ID || "" : "");
const session = () => store.get(K.token(envKey()));

/* How a site is remembered between visits, so what has been dealt with stays
   dealt with.

   Position came first, and every list already written is full of those keys, so
   they still count. On their own they leak: AFDC moves about 0.8% of its
   coordinates in a fortnight — 123 records in the eleven days between two of
   this repo's own snapshots, median 48 m — and a site that shifts a metre mints
   a new key, forgets it was skipped, and comes back round next time.

   So an AFDC record id is preferred when there is one. It is the same id
   whatever the coordinate does. Reading matches on any of a site's keys, which
   is what keeps lists written before this from being quietly discarded, and
   what makes a site stay skipped when its cluster gains or loses a record. */
const posKey = (s) => `${s.net}|${s.lat.toFixed(5)},${s.lon.toFixed(5)}`;
/* Any published id the site has, in either register. Not gated on which source
   the site came from any more: a Supercharger has supercharge.info's id and,
   where AFDC lists it too, AFDC's — and either is steadier than the coordinate
   the position key is built from. */
const refKeys = (s) => [
  ...(s.refs || []).map((r) => `afdc:${r}`),
  ...(s.sc ? [`sc:${s.sc}`] : []),
];
const keyOf = (s) => refKeys(s)[0] || posKey(s);
const keysOf = (s) => [posKey(s), ...refKeys(s)];
const isRemembered = (set, s) => keysOf(s).some((k) => set.has(k));
const remember = (bucket, s) => {
  const list = store.get(bucket, []);
  if (!list.includes(keyOf(s))) { list.push(keyOf(s)); store.set(bucket, list.slice(-4000)); }
};

/* ---------------------------------------------------------------------- auth */

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/* Getting the code back out of the popup.

   OSM serves its login and authorize pages with Cross-Origin-Opener-Policy:
   same-origin, which puts the popup in a different browsing context group the
   moment it navigates there. The link between the two windows is then cut for
   good: back on our own origin the landing page sees window.opener === null, so
   postMessage has nowhere to go, and this side sees win.closed === true while
   the popup sits plainly open on screen — so polling it only ever produces a
   false "you closed the window".

   Both windows are still same-origin, though, so the handoff goes over channels
   that never involved the opener relationship: BroadcastChannel, with a
   localStorage write as the fallback for browsers without it (a storage event
   fires in every other window of the origin). postMessage stays as a fast path
   for the day OSM drops the header. Nothing here waits on win.closed; the
   editor cancels by hand, or it times out. */
const AUTH_CHANNEL = "cb-osm-auth";
const HANDOFF = "cb.osm.handoff";
const AUTH_TIMEOUT = 300000;
let authCancel = null;

function waitForCode(state) {
  return new Promise((resolve, reject) => {
    const chan = "BroadcastChannel" in window ? new BroadcastChannel(AUTH_CHANNEL) : null;
    let timer = null;
    const stop = () => {
      clearTimeout(timer);
      chan?.close();
      removeEventListener("message", onWindow);
      removeEventListener("storage", onStorage);
      authCancel = null;
    };
    const take = (d) => {
      if (!d || d.source !== AUTH_CHANNEL || d.state !== state) return;
      stop();
      store.del(HANDOFF);
      if (d.error) reject(new Error(`${d.error}${d.description ? `: ${d.description}` : ""}`));
      else resolve(d.code);
    };
    const onWindow = (ev) => { if (ev.origin === location.origin) take(ev.data); };
    const onStorage = (ev) => {
      if (ev.key !== HANDOFF || !ev.newValue) return;
      try { take(JSON.parse(ev.newValue)); } catch { /* someone else's key */ }
    };
    if (chan) chan.onmessage = (ev) => take(ev.data);
    addEventListener("message", onWindow);
    addEventListener("storage", onStorage);
    authCancel = () => { stop(); reject(new Error("Sign-in cancelled.")); };
    timer = setTimeout(() => { stop(); reject(new Error("Sign-in timed out — nothing came back from OpenStreetMap.")); }, AUTH_TIMEOUT);
  });
}

async function pkcePair() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)).buffer);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(digest) };
}

/* Authorization code + PKCE in a popup. PKCE exists so a public client can do
   this with no secret to leak: the code that comes back is useless without the
   verifier, which never leaves this tab. */
async function signIn() {
  const id = clientId();
  if (!id) throw new Error("No OAuth client id set.");
  const env = envKey();
  const { verifier, challenge } = await pkcePair();
  const state = b64url(crypto.getRandomValues(new Uint8Array(12)).buffer);
  const url = `${ENVS[env].web}/oauth2/authorize?` + new URLSearchParams({
    client_id: id,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  store.del(HANDOFF);
  const win = window.open(url, "osm-auth", "width=620,height=720,menubar=no,toolbar=no");
  if (!win) throw new Error("The sign-in window was blocked. Allow popups for this site and try again.");

  const code = await waitForCode(state);

  const res = await fetch(`${ENVS[env].web}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: id,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed (HTTP ${res.status}).${tokenHint(await res.text())}`);
  const token = await res.json();

  const who = await fetch(`${ENVS[env].api}/api/0.6/user/details.json`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

  store.set(K.token(env), { access: token.access_token, user: who?.user?.display_name || "signed in" });
  return session();
}

/* OAuth error codes say little on their own, and one of them has a cause so
   common it is worth naming: OSM's application form ticks "Confidential
   application" by default, and a confidential client must present a secret this
   page cannot hold. Doorkeeper reports that as invalid_client — the same code
   it uses for an id it has never seen. */
function tokenHint(body) {
  let err = "";
  try { err = JSON.parse(body).error || ""; } catch { /* not JSON */ }
  if (err === "invalid_client") {
    return " OpenStreetMap will not accept this client id from a browser. Check that the" +
      " application has Confidential unticked — a confidential app needs a secret this page cannot" +
      " keep — and that it is registered on the server you are signed in to.";
  }
  if (err === "invalid_grant") {
    return ` The registered redirect URI must be exactly ${REDIRECT} — scheme, host, port and path all count.`;
  }
  return err ? ` (${err})` : " Check the client id and redirect URI.";
}

function signOut() {
  store.del(K.token(envKey()));
  paintSide();
}

/* ----------------------------------------------------------------- OSM API */

const xesc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));

/* Only non-empty strings are tags. Without this, a null value anywhere upstream
   is serialised as the literal text "null" and lands on the node as
   `brand=null` — a tag nothing can interpret, invisible in a diff review, and
   left for someone to delete by hand later. XML has no way to say "absent", so
   absence has to be enforced here, at the one door everything leaves by. */
const NOT_A_VALUE = new Set(["null", "undefined", "nan", "none"]);
const usableTag = ([k, v]) => {
  if (typeof k !== "string" || !k.trim()) return false;
  if (v == null) return false;
  const s = String(v).trim();
  return s !== "" && !NOT_A_VALUE.has(s.toLowerCase());
};
const cleanTags = (tags) => Object.fromEntries(
  Object.entries(tags).filter(usableTag).map(([k, v]) => [k.trim(), String(v).trim()]));
const tagXml = (tags) => Object.entries(cleanTags(tags))
  .map(([k, v]) => `<tag k="${xesc(k)}" v="${xesc(v)}"/>`).join("");

async function osmFetch(path, opts = {}) {
  const s = session();
  const res = await fetch(`${ENV().api}${path}`, {
    ...opts,
    headers: { ...(opts.headers || {}), ...(s ? { Authorization: `Bearer ${s.access}` } : {}) },
  });
  if (res.status === 401 || res.status === 403) {
    store.del(K.token(envKey()));
    throw new Error("OSM rejected the token — sign in again.");
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${(await res.text()).trim().slice(0, 200) || path}`);
  return res;
}

async function createChangeset(tags) {
  const res = await osmFetch("/api/0.6/changeset/create", {
    method: "PUT",
    headers: { "Content-Type": "text/xml" },
    body: `<osm><changeset>${tagXml(tags)}</changeset></osm>`,
  });
  return (await res.text()).trim();
}

async function uploadNode(cs, lat, lon, tags) {
  const body =
    `<osmChange version="0.6" generator="${xesc(APP)} ${VERSION}"><create>` +
    `<node id="-1" version="0" changeset="${cs}" lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}">` +
    tagXml(tags) +
    `</node></create></osmChange>`;
  const res = await osmFetch(`/api/0.6/changeset/${cs}/upload`, {
    method: "POST",
    headers: { "Content-Type": "text/xml" },
    body,
  });
  const doc = new DOMParser().parseFromString(await res.text(), "text/xml");
  return doc.querySelector("node")?.getAttribute("new_id") || null;
}

const closeChangeset = (cs) => osmFetch(`/api/0.6/changeset/${cs}/close`, { method: "PUT" });

/* Read an element with its tags and version. The whole document is kept, not
   just the tags: `applyTags` mutates and re-sends this very XML, which is what
   keeps a way's <nd> children and a relation's <member> children intact. */
async function fetchElement(type, id) {
  const doc = new DOMParser().parseFromString(
    await (await osmFetch(`/api/0.6/${type}/${id}`)).text(), "text/xml");
  const el = doc.getElementsByTagName(type)[0];
  if (!el) throw new Error(`${type} ${id} is not in OSM any more`);
  const tags = {};
  for (const t of el.getElementsByTagName("tag")) tags[t.getAttribute("k")] = t.getAttribute("v");
  return { doc, el, type, id, version: el.getAttribute("version"),
           visible: el.getAttribute("visible") !== "false", tags };
}

/* Values that say "something is here" and nothing more. Replacing one of these
   with a real classification loses no information, so it is an upgrade rather
   than a conflict, and safe to tick by default.

   Kept deliberately short. building=commercial is not on it: that is a genuine
   classification someone chose, and overruling it with retail is a judgement
   call for the human, not a default. */
const GENERIC = {
  building: new Set(["yes", "true", "1", "unclassified", "undefined"]),
  shop: new Set(["yes"]),
  amenity: new Set(["yes"]),
};

const isUpgrade = (key, had, want) =>
  had !== want && GENERIC[key]?.has(String(had).toLowerCase()) === true;

/* What our tags would do to theirs, one row per key.

   Four kinds, because they need different defaults: "add" and "upgrade" are
   safe and start ticked, "change" would overwrite something real and never
   does, "same" is the evidence that most of the record already agrees, which is
   what makes the handful of change rows worth actually reading. */
function planTags(existing, proposed) {
  const rows = [];
  for (const [k, v] of Object.entries(cleanTags(proposed))) {
    const had = existing[k];
    if (had == null) rows.push({ key: k, from: null, to: v, kind: "add" });
    else if (had === v) rows.push({ key: k, from: had, to: v, kind: "same" });
    else if (isUpgrade(k, had, v)) rows.push({ key: k, from: had, to: v, kind: "upgrade" });
    else rows.push({ key: k, from: had, to: v, kind: "change" });
  }
  const order = { change: 0, upgrade: 1, add: 2, same: 3 };
  rows.sort((a, b) => order[a.kind] - order[b.kind] || a.key.localeCompare(b.key));
  return rows;
}

/* Which rows a fresh diff should arrive with ticked. */
const safeKinds = new Set(["add", "upgrade"]);

/* Tags OSM has that we do not. Never touched — only shown, so it is obvious
   that uploading leaves them alone. */
function extraTags(existing, proposed) {
  const mine = cleanTags(proposed);
  return Object.entries(existing)
    .filter(([k]) => !(k in mine))
    .map(([k, v]) => ({ key: k, value: v }));
}

/* Replace an element's tags outright — every existing tag off, this set on.

   `applyTags` cannot express this: it writes values, and an empty value would
   land in OSM as `k=""` rather than removing anything. Demoting a station node
   to a charge point needs the removal to be real, or the node keeps saying
   `amenity=charging_station` beside the area that now says it too.

   Geometry and version handling are `applyTags`'s, for the same reasons. */
async function replaceTags(type, id, tags, cs, expect = null) {
  const cur = await fetchElement(type, id);
  if (expect != null && cur.version !== String(expect)) {
    const e = new Error(`${type} ${id} changed in OSM while you were working (v${expect} → v${cur.version}).`);
    e.stale = true;
    throw e;
  }
  if (!cur.visible) throw new Error(`${type} ${id} has been deleted in OSM`);
  const { doc, el } = cur;
  for (const t of [...el.getElementsByTagName("tag")]) el.removeChild(t);
  for (const [k, v] of Object.entries(cleanTags(tags))) {
    const t = doc.createElement("tag");
    t.setAttribute("k", k);
    t.setAttribute("v", v);
    el.appendChild(t);
  }
  el.setAttribute("changeset", cs);
  const body = `<osmChange version="0.6" generator="${xesc(APP)} ${VERSION}"><modify>` +
    new XMLSerializer().serializeToString(el) + `</modify></osmChange>`;
  const res = await osmFetch(`/api/0.6/changeset/${cs}/upload`, {
    method: "POST", headers: { "Content-Type": "text/xml" }, body,
  });
  const out = new DOMParser().parseFromString(await res.text(), "text/xml");
  return { version: out.getElementsByTagName(type)[0]?.getAttribute("new_version") || null };
}

/* Write `tags` onto an element that already exists.

   The element is re-fetched and its own XML mutated rather than rebuilt from a
   tag list: an osmChange <modify> replaces the element wholesale, so a way sent
   without its <nd> children loses its geometry and a relation without its
   <member> children loses its parts. Serialising the fetched element keeps
   every child and attribute, version included.

   Re-fetching here rather than trusting the copy the diff was built from is
   what makes the upload safe: if the version moved under us the API 409s, and
   `expect` lets the caller say which version the human actually reviewed.

   Several tags at once rather than one call each, because tags describing one
   thing are one edit: separate uploads would put a half-described element on
   the map in between. Nothing is sent when every value is already there. */
async function applyTags(type, id, tags, cs, expect = null) {
  const cur = await fetchElement(type, id);
  if (expect != null && cur.version !== String(expect)) {
    const e = new Error(
      `${type} ${id} changed in OSM while you were reviewing it ` +
      `(v${expect} \u2192 v${cur.version}). Re-read it and look again.`);
    e.stale = true;
    e.version = cur.version;
    throw e;
  }
  if (!cur.visible) throw new Error(`${type} ${id} has been deleted in OSM`);

  const { doc, el } = cur;
  const byKey = new Map();
  for (const t of el.getElementsByTagName("tag")) byKey.set(t.getAttribute("k"), t);

  const written = [];
  for (const [k, v] of Object.entries(cleanTags(tags))) {
    const had = byKey.get(k);
    if (had) {
      if (had.getAttribute("v") === v) continue;
      had.setAttribute("v", v);
    } else {
      const t = doc.createElement("tag");
      t.setAttribute("k", k);
      t.setAttribute("v", v);
      el.appendChild(t);
    }
    written.push(`${k}=${v}`);
  }
  if (!written.length) return { version: cur.version, touched: 0, written };

  el.setAttribute("changeset", cs);
  const body = `<osmChange version="0.6" generator="${xesc(APP)} ${VERSION}"><modify>` +
    new XMLSerializer().serializeToString(el) + `</modify></osmChange>`;
  const res = await osmFetch(`/api/0.6/changeset/${cs}/upload`, {
    method: "POST", headers: { "Content-Type": "text/xml" }, body,
  });
  const out = new DOMParser().parseFromString(await res.text(), "text/xml");
  return { version: out.getElementsByTagName(type)[0]?.getAttribute("new_version") || null,
           touched: written.length, written };
}

/* ------------------------------------------------------------------ tracing

   Drawing an outline from clicks on imagery, and the squaring that makes it
   look like a building someone surveyed rather than a hand-drawn blob. Moved
   here from the dealers page when the charging editor needed to trace too:
   nothing about a rectangle is specific to a car dealership. */

/* Create a closed way from traced points, tags and all.

   The ring closes by repeating the first node's id as the last <nd>, not by
   sending a duplicate node at the same spot — a way whose ends are two
   different nodes is not an area, and validators say so. */
async function createWay(points, tags, cs) {
  const pts = dedupe(points);
  if (pts.length < 3) throw new Error("A building needs at least three corners.");

  const nodeIds = pts.map((_, i) => -(i + 1));
  const wayId = -(pts.length + 1);
  const nodes = pts.map((p, i) =>
    `<node id="${nodeIds[i]}" version="0" changeset="${cs}" ` +
    `lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}"/>`).join("");
  const nds = [...nodeIds, nodeIds[0]].map((r) => `<nd ref="${r}"/>`).join("");
  const body =
    `<osmChange version="0.6" generator="${xesc(APP)} ${VERSION}"><create>` +
    nodes +
    `<way id="${wayId}" version="0" changeset="${cs}">${nds}${tagXml(tags)}</way>` +
    `</create></osmChange>`;

  const res = await osmFetch(`/api/0.6/changeset/${cs}/upload`, {
    method: "POST", headers: { "Content-Type": "text/xml" }, body,
  });
  const out = new DOMParser().parseFromString(await res.text(), "text/xml");
  const way = out.getElementsByTagName("way")[0];
  return {
    id: way?.getAttribute("new_id") || null,
    version: way?.getAttribute("new_version") || null,
    nodes: [...out.getElementsByTagName("node")].map((n) => n.getAttribute("new_id")),
  };
}

/* Two clicks landing on the same pixel would make a zero-length segment. */
function dedupe(points) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.lat - p.lat) < 1e-7 && Math.abs(last.lon - p.lon) < 1e-7) continue;
    out.push(p);
  }
  // a traced ring often ends where it started; the closing <nd> handles that
  if (out.length > 2) {
    const a = out[0], b = out[out.length - 1];
    if (Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lon - b.lon) < 1e-7) out.pop();
  }
  return out;
}

/* --------------------------------------------------------- squaring a trace */

/* Traced corners are never quite right-angled, and a dealership is a box. These
   two turn a rough trace into a rectilinear one, the way JOSM's Q does.

   Everything happens on a local metre plane centred on the shape, so the maths
   is plain Euclidean geometry; at building scale the flat-earth error is well
   under a centimetre.

   The raw clicks are always kept by the caller and squaring recomputed from
   them, never applied on top of its own output — squaring a squared shape drifts. */
function plane(points) {
  const lat0 = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const lon0 = points.reduce((s, p) => s + p.lon, 0) / points.length;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110540;
  return {
    to: (p) => ({ x: (p.lon - lon0) * kx, y: (p.lat - lat0) * ky }),
    back: (q) => ({ lat: lat0 + q.y / ky, lon: lon0 + q.x / kx }),
  };
}

/* The angle the building is built on, folded into 0-90°.

   Averaging the edge angles directly would be wrong: 1° and 89° are the same
   grid, a degree either side of the axis. Multiplying by four first makes the
   four-fold symmetry a full turn, so a circular mean lands in the right place,
   and dividing back recovers the heading. Long edges count for more, since they
   carry the shape's real direction. */
function dominantAngle(pts) {
  let C = 0, S = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.01) continue;
    const ang = Math.atan2(dy, dx);
    C += len * Math.cos(4 * ang);
    S += len * Math.sin(4 * ang);
  }
  return Math.atan2(S, C) / 4;
}

const rot = (p, t) => ({
  x: p.x * Math.cos(t) - p.y * Math.sin(t),
  y: p.x * Math.sin(t) + p.y * Math.cos(t),
});

/* Snap every edge to horizontal or vertical, then put the shape back.

   Each edge is pulled onto whichever axis it is already closer to by moving
   both its ends to their shared mean. Neighbouring edges fight over the corner
   they share, so it is run repeatedly until the moves die away — which is what
   makes L-shapes and courtyards work and not just rectangles. */
function squareUp(points, passes = 40) {
  const ring = dedupe(points);
  if (ring.length < 4) return ring.slice();

  const pl = plane(ring);
  const flat = ring.map(pl.to);
  const theta = dominantAngle(flat);
  const p = flat.map((q) => rot(q, -theta));

  for (let it = 0; it < passes; it++) {
    let moved = 0;
    for (let i = 0; i < p.length; i++) {
      const j = (i + 1) % p.length;
      const dx = Math.abs(p[j].x - p[i].x);
      const dy = Math.abs(p[j].y - p[i].y);
      if (dx >= dy) {
        const m = (p[i].y + p[j].y) / 2;
        moved += Math.abs(p[i].y - m) + Math.abs(p[j].y - m);
        p[i].y = p[j].y = m;
      } else {
        const m = (p[i].x + p[j].x) / 2;
        moved += Math.abs(p[i].x - m) + Math.abs(p[j].x - m);
        p[i].x = p[j].x = m;
      }
    }
    if (moved < 1e-4) break;
  }
  return p.map((q) => pl.back(rot(q, theta)));
}

/* Three clicks are enough for a box: two along one wall, the third anywhere on
   the opposite side to give the depth. Faster than tracing four corners and
   exactly square by construction. */
function rectangleFrom3(a, b, c) {
  const pl = plane([a, b, c]);
  const A = pl.to(a), B = pl.to(b), C = pl.to(c);
  const ex = B.x - A.x, ey = B.y - A.y;
  const len = Math.hypot(ex, ey);
  if (len < 0.01) return [a, b, c];
  const ux = ex / len, uy = ey / len;          // along the wall
  const nx = -uy, ny = ux;                     // out from it
  const depth = (C.x - A.x) * nx + (C.y - A.y) * ny;
  const off = { x: nx * depth, y: ny * depth };
  return [
    pl.back(A),
    pl.back(B),
    pl.back({ x: B.x + off.x, y: B.y + off.y }),
    pl.back({ x: A.x + off.x, y: A.y + off.y }),
  ];
}

/* What the caller should draw and upload, given the clicks and the toggle. */
function shapeFor(raw, square) {
  const ring = dedupe(raw);
  if (!square) return ring;
  if (ring.length === 3) return rectangleFrom3(ring[0], ring[1], ring[2]);
  if (ring.length >= 4) return squareUp(ring);
  return ring;
}

/* The worst corner error left in a ring, in degrees off square — what the page
   shows to say whether squaring actually did anything. */
function worstCorner(points) {
  const ring = dedupe(points);
  if (ring.length < 3) return null;
  const pl = plane(ring);
  const p = ring.map(pl.to);
  let worst = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[(i - 1 + p.length) % p.length], b = p[i], c = p[(i + 1) % p.length];
    const v1 = { x: a.x - b.x, y: a.y - b.y };
    const v2 = { x: c.x - b.x, y: c.y - b.y };
    const m1 = Math.hypot(v1.x, v1.y), m2 = Math.hypot(v2.x, v2.y);
    if (m1 < 0.01 || m2 < 0.01) continue;
    const dot = (v1.x * v2.x + v1.y * v2.y) / (m1 * m2);
    const deg = (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
    worst = Math.max(worst, Math.abs(90 - Math.min(deg, 180 - deg)));
  }
  return Math.round(worst * 10) / 10;
}

/* ------------------------------------------------------- what is already here */

const R = 111320;
function metresBetween(a, b) {
  const dy = (a.lat - b.lat) * R;
  const dx = (a.lon - b.lon) * R * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

/* Everything mapped in a small box, so the page can say "there is already a
   building here" before a second one goes in. Our match list comes from an
   Overpass snapshot that ages; this is the live check. */

/* What OSM already has here, live. The board's own "unmapped" flag comes from a
   snapshot hours or days old, so it is a filter, not a guarantee — this is the
   check that stops a duplicate going in.

   The radius is the board's own 150 m matching radius, so a hit here means the
   next data refresh would call this site mapped anyway. It is also as wide as
   this can afford to be: /map returns everything in the box, buildings and all,
   and 150 m of a dense downtown is already a few hundred KB. */
/* Car marques, for spotting a dealership by its name when it carries no shop
   tag — "Toyota of Orlando" on a building is as good a signal as shop=car. */
const MARQUES = /\b(tesla|ford|chevrolet|chevy|toyota|honda|nissan|bmw|mercedes|benz|audi|volkswagen|vw|hyundai|kia|subaru|mazda|lexus|acura|infiniti|volvo|porsche|jaguar|land rover|range rover|mitsubishi|buick|gmc|cadillac|chrysler|dodge|jeep|ram|lincoln|genesis|polestar|rivian|lucid|fiat|alfa romeo|maserati|bentley|ferrari|lamborghini|mini|smart|nissan|scion)\b/i;
/* Several marques are also ordinary street names — Ford Street, Lincoln Avenue,
   Dodge Road — so a name alone proves nothing. */
const MARQUE_STREET = /\b(ford|lincoln|dodge|jeep|smart|genesis|mini|ram)\s+(st|street|rd|road|ave|avenue|blvd|boulevard|ln|lane|dr|drive|way|pkwy|parkway|hwy|highway)\b/i;
const CAR_SHOP = new Set(["car", "car_repair", "car_parts"]);
function CAR_POI(t) {
  if (CAR_SHOP.has(t.shop) || t.amenity === "car_rental" || t.office === "car_dealer") return true;
  // Anything already classified as some other business is that business, whatever
  // its name says: a bakery on Ford Street is a bakery.
  if (t.shop || t.amenity || t.leisure || t.tourism || t.healthcare) return false;
  const name = t.name || t.brand || "";
  if (MARQUE_STREET.test(name)) return false;
  return !!(t.building || t.landuse || t.office) && MARQUES.test(name);
}

async function nearbyStations(lat, lon, m = 250) {
  const dLat = m / 111320;
  const dLon = dLat / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  const bbox = [lon - dLon, lat - dLat, lon + dLon, lat + dLat].map((v) => v.toFixed(6)).join(",");
  const res = await osmFetch(`/api/0.6/map?bbox=${bbox}`);
  const doc = new DOMParser().parseFromString(await res.text(), "text/xml");
  const here = { lat, lon };

  const pos = new Map();
  for (const n of doc.getElementsByTagName("node")) {
    pos.set(n.getAttribute("id"), { lat: +n.getAttribute("lat"), lon: +n.getAttribute("lon") });
  }
  const ways = new Map();
  for (const w of doc.getElementsByTagName("way")) {
    ways.set(w.getAttribute("id"),
      [...w.getElementsByTagName("nd")].map((nd) => pos.get(nd.getAttribute("ref"))).filter(Boolean));
  }
  const tagsOf = (e) => Object.fromEntries(
    [...e.getElementsByTagName("tag")].map((t) => [t.getAttribute("k"), t.getAttribute("v")]));
  /* A charge point is a stall, not a site — but a pin standing among them is
     standing on charging that is already mapped, and this check exists to stop
     a second copy of it going in. Which of the two was found is kept on the
     record: the answer to a station is "this is already here", while bare
     stalls with no station around them are the charge-points tool's job. */
  const kindOf = (t) => t.amenity === "charging_station" ? "station"
                      : t.man_made === "charge_point" ? "point" : null;
  const isStation = (t) => kindOf(t) != null;
  const middle = (pts) => ({
    lat: pts.reduce((a, p) => a + p.lat, 0) / pts.length,
    lon: pts.reduce((a, p) => a + p.lon, 0) / pts.length,
  });

  const out = [];
  const cars = [];
  const sort = (t, rec) => {
    const kind = kindOf(t);
    if (kind) out.push({ ...rec, kind });
    else if (CAR_POI(t)) cars.push(rec);
  };
  for (const n of doc.getElementsByTagName("node")) {
    const t = tagsOf(n);
    if (!isStation(t) && !CAR_POI(t)) continue;
    const p = pos.get(n.getAttribute("id"));
    sort(t, { type: "node", id: n.getAttribute("id"), tags: t, ...p, away: metres(here, p) });
  }
  for (const w of doc.getElementsByTagName("way")) {
    const t = tagsOf(w);
    if (!isStation(t) && !CAR_POI(t)) continue;
    const pts = ways.get(w.getAttribute("id")) || [];
    if (!pts.length) continue;
    sort(t, { type: "way", id: w.getAttribute("id"), tags: t, ...middle(pts), away: ringDistance(here, pts) });
  }
  /* Relations were the gap that let a 168-stall Supercharger through: a site
     mapped as a multipolygon comes back from /map as a relation, and reading
     only nodes and ways made it invisible. Distance is to the geometry, not to
     the middle of it — standing inside the polygon is zero metres away. */
  for (const r of doc.getElementsByTagName("relation")) {
    const t = tagsOf(r);
    if (!isStation(t)) continue;
    const members = [...r.getElementsByTagName("member")]
      .filter((mem) => mem.getAttribute("type") === "way")
      .map((mem) => ways.get(mem.getAttribute("ref")) || []);
    const pts = members.flat();
    if (!pts.length) continue;
    out.push({
      type: "relation", id: r.getAttribute("id"), tags: t, kind: kindOf(t), ...middle(pts),
      away: Math.min(...members.filter((p) => p.length).map((p) => ringDistance(here, p))),
    });
  }
  // the query box is a square, so trim its corners back to the radius claimed
  const trim = (list) => list.filter((o) => o.away <= m).sort((a, b) => a.away - b.away);
  return {
    stations: trim(out),
    cars: cars.filter((c) => c.away <= CAR_NEAR).sort(carOrder),
  };
}

/* Which of several car businesses owns the charger. Distance alone gets this
   wrong: a quick-lube unit three metres nearer than the dealership it shares a
   lot with is not the better answer. So containment first — inside a polygon
   beats any distance — then what the business actually is, and only then how
   far. Whatever the order, the choice is the editor's. */
const CAR_NEAR = 150;
const carRank = (t) =>
  t.shop === "car" || t.office === "car_dealer" ? 0 :
  t.amenity === "car_rental" ? 1 :
  t.shop === "car_repair" || t.shop === "car_parts" ? 2 : 3;
const carOrder = (a, b) =>
  (a.away === 0 ? 0 : 1) - (b.away === 0 ? 0 : 1) ||
  carRank(a.tags) - carRank(b.tags) ||
  a.away - b.away;

/* Metres from a point to a ring of points: zero if it is inside, otherwise the
   nearest edge — not the nearest corner, which on a four-node parking lot can
   be out by half its width. */
function ringDistance(p, pts) {
  if (!pts.length) return Infinity;
  if (pts.length === 1) return metres(p, pts[0]);
  if (pts.length >= 3 && inRing(p.lon, p.lat, pts.map((q) => [q.lon, q.lat]))) return 0;
  const kx = 111320 * Math.cos((p.lat * Math.PI) / 180);
  const xy = (q) => [(q.lon - p.lon) * kx, (q.lat - p.lat) * 111320];
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = xy(pts[i - 1]), [bx, by] = xy(pts[i]);
    const dx = bx - ax, dy = by - ay;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

/* ------------------------------------------------------------------ mercator */

const TILE = 256;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const LAT_MAX = 85.05112878;
const lon2x = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const lat2y = (lat, z) => {
  const s = Math.sin((clamp(lat, -LAT_MAX, LAT_MAX) * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z;
};
const x2lon = (x, z) => (x / 2 ** z) * 360 - 180;
const y2lat = (y, z) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};
const MERC_R = 6378137;
const merc = (lon, lat) => [
  ((lon * Math.PI) / 180) * MERC_R,
  Math.log(Math.tan(Math.PI / 4 + ((clamp(lat, -LAT_MAX, LAT_MAX) * Math.PI) / 180) / 2)) * MERC_R,
];

/* Build one tile's URL. ELI templates carry a small zoo of placeholders: XYZ
   layers use {zoom}/{x}/{y} with {-y} for the flipped TMS scheme, WMS layers
   want a projected bounding box, and Esri's export endpoint spells the
   projection {wkid} instead of {proj}. */
/* How far past a layer's own maximum the view may travel.

   Three doublings is 8× upscaled — coarse, but a stall is still a stall, and
   that is the judgement being made. The layer's own maximum is capped first
   because some index entries claim depths nobody serves: OpenAerialMap says
   z31, and taking that at face value would let the view run to z34 where the
   pixels have long stopped meaning anything.

   This used to be a flat 22, which happened to be exactly the maximum the
   default Esri layer reports — so on the layer almost everyone is looking at,
   the ceiling landed precisely where the imagery ran out and there was no
   over-zoom to be had at all. */
const OVERZOOM = 3;
const ceiling = (L) => Math.min(L?.max ?? 19, 22) + OVERZOOM;

function tileUrl(L, x, y, z) {
  if (L.type === "wms") {
    const [w, s] = merc(x2lon(x, z), y2lat(y + 1, z));
    const [e, n] = merc(x2lon(x + 1, z), y2lat(y, z));
    return L.url
      .replace(/\{proj\}/gi, "EPSG:3857")
      .replace(/\{wkid\}/gi, "3857")
      .replace(/\{bbox\}/gi, `${w},${s},${e},${n}`)
      .replace(/\{width\}/gi, TILE)
      .replace(/\{height\}/gi, TILE);
  }
  return L.url
    .replace(/\{switch:([^}]+)\}/gi, (_, opts) => { const a = opts.split(","); return a[Math.abs(x + y) % a.length]; })
    .replace(/\{-y\}/gi, 2 ** z - 1 - y)
    .replace(/\{zoom\}|\{z\}/gi, z)
    .replace(/\{x\}/gi, x)
    .replace(/\{y\}/gi, y);
}

/* ------------------------------------------------------------------ tile map */

/* A small slippy map on a canvas. The board ships no mapping library and makes
   no third-party requests until you open this editor, and that stays true here:
   tiles are plain <img> loads from whichever imagery layer is selected. */
class TileMap {
  constructor(canvas, host) {
    this.cv = canvas;
    this.host = host;
    this.center = { lat: 39.5, lon: -98.35 };
    this.zoom = 18;
    this.layer = null;
    this.cache = new Map();
    this.pin = null;          // {lat, lon} — draggable
    this.ghost = null;        // {lat, lon} — where the data said it was
    this.others = [];         // existing OSM stations nearby
    this.onpin = null;
    this.onstat = null;
    this.stat = { ok: 0, err: 0 };
    this.over = 0;
    this.frame = 0;
    this.W = 0; this.H = 0;

    canvas.style.touchAction = "none";
    canvas.addEventListener("pointerdown", (e) => this.down(e));
    canvas.addEventListener("pointermove", (e) => this.move(e));
    canvas.addEventListener("pointerup", (e) => this.up(e));
    canvas.addEventListener("pointercancel", () => { this.drag = null; });
    canvas.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    canvas.addEventListener("dblclick", (e) => {
      const p = this.at(e);
      this.zoomAround(p.x, p.y, 1);
    });
    this.ro = new ResizeObserver(() => this.schedule());
    this.ro.observe(host);
  }

  at(e) {
    const r = this.cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  toPx(lat, lon) {
    const z = this.zoom;
    return [
      (lon2x(lon, z) - lon2x(this.center.lon, z)) * TILE + this.W / 2,
      (lat2y(lat, z) - lat2y(this.center.lat, z)) * TILE + this.H / 2,
    ];
  }
  toLatLon(px, py) {
    const z = this.zoom;
    return {
      lat: y2lat(lat2y(this.center.lat, z) + (py - this.H / 2) / TILE, z),
      lon: x2lon(lon2x(this.center.lon, z) + (px - this.W / 2) / TILE, z),
    };
  }
  setView(lat, lon, zoom) {
    this.center = { lat, lon };
    if (zoom != null) this.zoom = zoom;
    this.schedule();
  }
  setLayer(L) {
    this.layer = L;
    // Switching from Esri to a z19 layer while zoomed deep would leave the view
    // 6 doublings past the data — 64× upscale is not imagery, it is fog.
    this.zoom = Math.min(this.zoom, ceiling(L));
    this.stat = { ok: 0, err: 0 };
    // recomputed on the next draw against the new layer's depth
    this.over = 0;
    this.schedule();
  }

  /* Hold the point under the cursor still while the scale changes — the only
     zoom that feels like the map rather than the window is moving. */
  zoomAround(px, py, dz) {
    const before = this.toLatLon(px, py);
    this.zoom = clamp(this.zoom + dz, 3, ceiling(this.layer));
    const z = this.zoom;
    this.center = {
      lon: x2lon(lon2x(before.lon, z) - (px - this.W / 2) / TILE, z),
      lat: y2lat(lat2y(before.lat, z) - (py - this.H / 2) / TILE, z),
    };
    this.schedule();
  }
  wheel(e) {
    e.preventDefault();
    const p = this.at(e);
    this.zoomAround(p.x, p.y, e.deltaY < 0 ? 0.4 : -0.4);
  }

  /* The pin's head sits 20 px above the coordinate it marks, so grab it there
     rather than at the point — otherwise you drag the map out from under it. */
  nearPin(p) {
    if (!this.pin) return false;
    const [x, y] = this.toPx(this.pin.lat, this.pin.lon);
    return Math.hypot(p.x - x, p.y - (y - 16)) < 18;
  }
  down(e) {
    const p = this.at(e);
    // `grab` lets the page offer its own draggable things — the charge-point
    // site uses it to nudge a misplaced node — and takes precedence over the
    // pin, which is the more obvious target and easy to reach for by mistake.
    const target = this.grab?.(p) ?? null;
    const onPin = !target && this.nearPin(p);
    this.drag = { mode: target ? "grab" : onPin ? "pin" : "pan", target, x: p.x, y: p.y, moved: 0 };
    // Guarded like its release below: a pointer that is no longer active throws
    // here, and losing capture is not a reason to lose the drag.
    try { this.cv.setPointerCapture(e.pointerId); } catch { /* nothing to capture */ }
    this.cv.style.cursor = target || onPin ? "grabbing" : "move";
  }
  move(e) {
    const p = this.at(e);
    if (!this.drag) {
      this.cv.style.cursor = (this.grab?.(p) ?? null) || this.nearPin(p) ? "grab" : "";
      return;
    }
    const dx = p.x - this.drag.x, dy = p.y - this.drag.y;
    this.drag.moved += Math.abs(dx) + Math.abs(dy);
    this.drag.x = p.x; this.drag.y = p.y;
    if (this.drag.mode === "grab") {
      this.ongrab?.(this.drag.target, this.toLatLon(p.x, p.y));
    } else if (this.drag.mode === "pin") {
      this.pin = this.toLatLon(p.x, p.y);
      this.onpin?.(this.pin);
    } else {
      this.center = this.toLatLon(this.W / 2 - dx, this.H / 2 - dy);
    }
    this.schedule();
  }
  up(e) {
    const d = this.drag;
    this.drag = null;
    this.cv.style.cursor = "";
    try { this.cv.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    // a click that did not travel is "put the pin here"
    if (d && d.moved < 5 && d.mode !== "grab") {
      const p = this.at(e);
      const ll = this.toLatLon(p.x, p.y);
      // The dealer site traces building outlines and wants the raw click; if it
      // consumes one, the pin stays where it is. Nothing else sets this hook.
      if (this.onmapclick?.(ll, p)) { this.schedule(); return; }
      if (this.pin) {
        this.pin = ll;
        this.onpin?.(this.pin);
        this.schedule();
      }
    }
  }

  tile(L, x, y, z) {
    const url = tileUrl(L, x, y, z);
    const hit = this.cache.get(url);
    if (hit === "err") return null;
    if (hit) return hit.complete && hit.naturalWidth ? hit : null;
    const img = new Image();
    img.decoding = "async";
    // The index lists layers, not promises. State servers go down, WMS
    // endpoints move, and a few refuse browsers outright — so keep score and
    // let the panel say so instead of showing bare ground.
    img.onload = () => { this.stat.ok++; this.onstat?.(); this.schedule(); };
    img.onerror = () => { this.stat.err++; this.cache.set(url, "err"); this.onstat?.(); };
    img.src = url;
    this.cache.set(url, img);
    if (this.cache.size > 600) this.cache.delete(this.cache.keys().next().value);
    return null;
  }

  /* While a tile loads, draw the matching slice of an ancestor already in cache.
     Without it, panning at z20 flashes empty ground on every move — and when
     the view has gone past what the layer serves, this is the only thing that
     puts ground under the clicks at all. */
  parent(ctx, L, x, y, z, px, py, size) {
    let want = null;
    for (let up = 1; up <= 6 && z - up >= (L.min || 0); up++) {
      const f = 2 ** up;
      const ax = Math.floor(x / f), ay = Math.floor(y / f);
      const img = this.cache.get(tileUrl(L, ax, ay, z - up));
      if (img && img !== "err" && img.complete && img.naturalWidth) {
        const s = TILE / f;
        ctx.drawImage(img, (x % f) * s, (y % f) * s, s, s, px, py, size, size);
        return;
      }
      // shallowest ancestor nobody has asked for yet — "err" and pending both
      // fail this, so a dead level is stepped over rather than retried
      if (!want && img === undefined) want = [ax, ay, z - up];
    }
    /* Nothing cached to blow up, so ask. Layers over-state their depth all the
       time — an index says z22 and the server has z19 for that county — and
       the ancestors were never fetched because the view jumped straight here
       instead of zooming through them. Without this the ground stays black and
       the panel calls a working layer dead. `tile` de-duplicates, so this is
       one request, not one per frame. */
    if (want) this.tile(L, ...want);
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.draw(); });
  }

  draw() {
    const cv = this.cv;
    const W = (this.W = this.host.clientWidth);
    const H = (this.H = this.host.clientHeight);
    if (!W || !H) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = `${W}px`; cv.style.height = `${H}px`;
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = cssv("--sunken");
    ctx.fillRect(0, 0, W, H);

    const L = this.layer;
    if (L) {
      // Past a layer's own maximum, keep asking for its deepest tiles and blow
      // them up. Placing a pin at z21 on 19-zoom imagery is blurry but honest;
      // dropping to z19 would take away the precision the pin is there for.
      const zInt = clamp(Math.floor(this.zoom), L.min || 0, L.max ?? 19);
      const size = TILE * 2 ** (this.zoom - zInt);
      // How many doublings past the layer's own depth this view is, so the
      // panel can say so. Blur that is explained is a judgement about the
      // imagery; blur that is not is a bug report.
      const over = Math.max(0, Math.floor(this.zoom) - zInt);
      if (over !== this.over) { this.over = over; this.onzoom?.(over); }
      const n = 2 ** zInt;
      const ox = W / 2 - lon2x(this.center.lon, zInt) * size;
      const oy = H / 2 - lat2y(this.center.lat, zInt) * size;
      const x0 = Math.floor(-ox / size), x1 = Math.ceil((W - ox) / size);
      const y0 = Math.max(0, Math.floor(-oy / size)), y1 = Math.min(n, Math.ceil((H - oy) / size));
      for (let ty = y0; ty < y1; ty++) {
        for (let tx = x0; tx < x1; tx++) {
          const wx = ((tx % n) + n) % n;
          const px = ox + tx * size, py = oy + ty * size;
          const img = this.tile(L, wx, ty, zInt);
          if (img) ctx.drawImage(img, px, py, size + 0.5, size + 0.5);
          else this.parent(ctx, L, wx, ty, zInt, px, py, size + 0.5);
        }
      }
    }

    // The charge-point site draws its own numbered members through this hook.
    if (this.drawOthers) this.drawOthers(ctx, this);
    else for (const o of this.others) {
      const [x, y] = this.toPx(o.lat, o.lon);
      ctx.strokeStyle = cssv("--s3");
      ctx.fillStyle = "rgba(0,0,0,.35)";
      ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.arc(x, y, 9, 0, 6.284); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, 2.4, 0, 6.284); ctx.fillStyle = cssv("--s3"); ctx.fill();
    }

    if (this.ghost && this.pin) {
      const g = this.toPx(this.ghost.lat, this.ghost.lon);
      const p = this.toPx(this.pin.lat, this.pin.lon);
      ctx.strokeStyle = cssv("--s4");
      ctx.setLineDash([4, 4]); ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(g[0], g[1]); ctx.lineTo(p[0], p[1]); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(g[0], g[1], 5, 0, 6.284); ctx.stroke();
    }

    if (this.pin) this.drawPin(ctx, ...this.toPx(this.pin.lat, this.pin.lon));
    this.drawScale(ctx, W, H);
  }

  drawPin(ctx, x, y) {
    ctx.save();
    ctx.translate(x, y);
    ctx.shadowColor = "rgba(0,0,0,.45)"; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2;
    ctx.fillStyle = cssv("--accent");
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(-9, -8, -11, -16, -11, -20);
    ctx.arc(0, -20, 11, Math.PI, 0);
    ctx.bezierCurveTo(11, -16, 9, -8, 0, 0);
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.fillStyle = cssv("--surface");
    ctx.beginPath(); ctx.arc(0, -20, 4.2, 0, 6.284); ctx.fill();
    // the point of the pin is the coordinate, so mark it exactly
    ctx.strokeStyle = cssv("--accent"); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(-5, 0); ctx.lineTo(5, 0); ctx.stroke();
    ctx.restore();
  }

  drawScale(ctx, W, H) {
    const mPerPx = (156543.03392 * Math.cos((this.center.lat * Math.PI) / 180)) / 2 ** this.zoom;
    const target = 90 * mPerPx;
    const pow = 10 ** Math.floor(Math.log10(target));
    const nice = [1, 2, 5, 10].find((k) => k * pow >= target) * pow;
    const px = nice / mPerPx;
    ctx.strokeStyle = cssv("--ink");
    ctx.fillStyle = cssv("--ink");
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = 2;
    const y = H - 16, x = 14;
    ctx.beginPath();
    ctx.moveTo(x, y - 5); ctx.lineTo(x, y); ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 5);
    ctx.stroke();
    ctx.font = '11px "IBM Plex Mono", monospace';
    ctx.fillText(nice >= 1000 ? `${nice / 1000} km` : `${nice} m`, x + px + 7, y + 1);
    ctx.globalAlpha = 1;
  }
}

/* ------------------------------------------------------------------ imagery */

/* Global fallbacks, used only if the Editor Layer Index cannot be reached.
   Neither carries a capture date, which is exactly why they are the fallback
   and never the automatic pick. */
const FALLBACK_LAYERS = [
  { id: "EsriWorldImagery", name: "Esri World Imagery", type: "tms", min: 0, max: 22, end: null, best: false,
    url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{zoom}/{y}/{x}",
    attr: "Esri, Maxar, Earthstar Geographics", geom: null },
  { id: "USGS-Imagery", name: "USGS Imagery", type: "tms", min: 0, max: 20, end: null, best: false,
    url: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{zoom}/{y}/{x}",
    attr: "USGS The National Map", geom: null },
];

let IMAGERY = null;

async function loadImagery() {
  if (IMAGERY) return IMAGERY;
  // Prefer the worker's slimmed copy; fall back to the index itself, which
  // GitHub Pages serves with permissive CORS.
  try {
    const res = await fetch(`${DATA_ORIGIN}/imagery${DATA_SUFFIX}`, { mode: "cors" });
    if (res.ok) {
      const body = await res.json();
      if (body.layers?.length) return (IMAGERY = body.layers);
    }
  } catch { /* fall through */ }
  try {
    const res = await fetch("https://osmlab.github.io/editor-layer-index/imagery.geojson");
    if (res.ok) {
      const body = await res.json();
      return (IMAGERY = body.features.map((f) => {
        const p = f.properties;
        return {
          id: p.id, name: p.name, type: p.type, url: p.url,
          min: p.min_zoom ?? 0, max: p.max_zoom ?? 19,
          start: p.start_date ?? null, end: p.end_date ?? null, best: !!p.best,
          attr: p.attribution?.text ?? null, attrUrl: p.attribution?.url ?? null,
          category: p.category, overlay: !!p.overlay, geom: f.geometry ?? null,
        };
      }));
    }
  } catch { /* fall through */ }
  return (IMAGERY = FALLBACK_LAYERS);
}

const inRing = (lon, lat, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
function covers(L, lon, lat) {
  const g = L.geom;
  if (!g) return true;                          // no polygon in the index means worldwide
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  return polys.some((rings) => inRing(lon, lat, rings[0]) && !rings.slice(1).some((h) => inRing(lon, lat, h)));
}

function usable(L) {
  if (!L.url || (L.type !== "tms" && L.type !== "wms")) return false;
  if (L.overlay) return false;
  if (L.category && L.category !== "photo" && L.category !== "historicphoto") return false;
  if (/\{apikey\}/i.test(L.url)) return false;
  return (L.max ?? 19) >= 16;                   // anything shallower cannot show a parking bay
}

/* Recency decides the pick, as asked — the sort key is the capture date, not
   sharpness, not the index's "best" flag.

   With one qualifier, which the phrase "for the area" earns: a worldwide layer
   never wins on date. Nothing photographs the whole planet by aircraft in a
   year, so every dated global layer is a satellite mosaic — Sentinel-2 at 10 m
   a pixel, on which a charging bay is a fraction of one pixel. They advertise a
   max zoom of 18 and a 2025 date, and would otherwise beat every real survey in
   the country. Aerial programmes are regional and always carry a footprint in
   the index, so "has a coverage polygon" separates the two cleanly. Global
   layers stay in the picker, one click away, and undated ones (Esri, USGS) sit
   at the bottom where a date-first sort puts them anyway.

   After date, false-colour infrared drops below true colour of the same vintage:
   just as recent, and you still cannot read a parking lot on it. */
const FALSE_COLOUR = /\b(cir|ir|infrared|false[- ]?colou?r|ndvi)\b/i;
// The layer chosen when nothing is pinned, and the one fallen back to when a
// layer serves nothing but errors.
const DEFAULT_LAYER = "EsriWorldImagery";
function dateKey(L) {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(String(L.end || L.start || ""));
  return m ? `${m[1]}-${m[2] || "12"}-${m[3] || "31"}` : "";
}
function rankLayers(lon, lat) {
  return (IMAGERY || [])
    .filter((L) => usable(L) && covers(L, lon, lat))
    .sort((a, b) =>
      Number(!a.geom) - Number(!b.geom) ||
      dateKey(b).localeCompare(dateKey(a)) ||
      Number(FALSE_COLOUR.test(a.name || "")) - Number(FALSE_COLOUR.test(b.name || "")) ||
      Number(!!b.best) - Number(!!a.best) ||
      (b.max ?? 0) - (a.max ?? 0));
}
const layerYear = (L) => (dateKey(L) ? dateKey(L).slice(0, 4) : "undated");

/* --------------------------------------------------------------------- tags */

/* What each network is called in OSM. The board's labels are display names and
   several are not what belongs in the tag: ChargePoint sells hardware onto
   sites other people own, so its stations get `network`, not `operator`. No
   wikidata ids are proposed — a wrong one is worse than a missing one, and they
   are not derivable from anything the board holds. */
const NETWORKS = {
  Tesla: { brand: "Tesla Supercharger", sockets: ["nacs"] },
  "Supercharger for Business": { brand: "Tesla Supercharger", sockets: ["nacs"] },
  "Electrify America": { brand: "Electrify America" },
  IONNA: { brand: "IONNA" },
  EVgo: { brand: "EVgo" },
  ChargePoint: { brand: "ChargePoint" },
  Blink: { brand: "Blink" },
  "bp pulse": { brand: "bp pulse" },
  "Shell Recharge": { brand: "Shell Recharge" },
  "Circle K": { brand: "Circle K" },
  "Francis Energy": { brand: "Francis Energy" },
  "Electric Era": { brand: "Electric Era" },
  "Rivian Adventure": { brand: "Rivian Adventure Network" },
  "Rivian Waypoints": { brand: "Rivian Waypoints" },
  "Red E": { brand: "Red E" },
  Independent: {},                              // nothing trustworthy to name
};
const SOCKET = { CCS1: "type1_combo", "NACS / Tesla": "nacs", CHAdeMO: "chademo", "J1772 (AC)": "type1" };

/* Wikidata ids. None are hard-coded: a QID cannot be derived from anything the
   board holds, and a plausible-looking wrong one is worse in OSM than none at
   all — it is invisible in the tag list and gets copied onward. So they are
   looked up against Wikidata and confirmed by eye, then remembered by brand
   name: confirm "Electrify America" once and every EA site after it arrives
   with brand:wikidata already filled in. The memory holds only what someone
   picked, never a guess.

   Brand only. `operator` asks a question these sources cannot answer — a
   ChargePoint unit in a hotel car park is operated by the hotel, not by
   ChargePoint — while the brand on the machine is exactly what they do know. */
const WD_KEYS = new Set(["brand"]);

/* What a mapper leaves behind when they can place a site but not pin it.

   AFDC publishes one coordinate per site — a pylon, an entrance, the middle of
   a forecourt — and imagery does not always show which. Saying so is worth more
   than a silent guess: `fixme` is what the rest of OSM reads to find work that
   needs a survey, so it turns an approximate node from a quiet inaccuracy into
   an open question somebody can answer on the ground. */
const FIXME_APPROX = "Location is approximate; needs a survey for precise location";
const wikidataMemory = () => store.get(K.wikidata, {}) || {};
function rememberWikidata(value, qid, label) {
  const m = wikidataMemory();
  m[value] = { qid, label: label || null };
  store.set(K.wikidata, m);
}
// Entries were bare QID strings before spelling was carried too.
function recallWikidata(value) {
  const hit = wikidataMemory()[value];
  if (!hit) return null;
  return typeof hit === "string" ? { qid: hit, label: null } : hit;
}
function forgetWikidata(value) {
  const m = wikidataMemory();
  delete m[value];
  store.set(K.wikidata, m);
}

/* A hand-edit is a confirmation too. Without this, correcting a name or a QID
   fixes one site and the next one of that network arrives with the old value
   again — Wikidata's label for the Tesla entity is "Tesla Supercharger
   network", where OSM says "Tesla Supercharger", so this is the normal case,
   not the exotic one. Memory is always keyed on the name as this tool proposes
   it, never on the corrected form, or the lookup would miss next time. */
function syncMemory(key) {
  const base = key.endsWith(":wikidata") ? key.slice(0, -":wikidata".length) : key;
  if (!WD_KEYS.has(base)) return;
  const qid = CUR.tags[`${base}:wikidata`];
  const name = CUR.tags[base];
  const raw = CUR.raw?.[base] || name;
  if (qid && name && raw) rememberWikidata(raw, qid, name);
}

// A network not in the table still has a name worth proposing as its brand —
// the board's label for it, which the editor can correct before saving.
const networkFor = (s) => NETWORKS[s.net] || { brand: s.net };

function proposeTags(s) {
  const t = { amenity: "charging_station" };
  const net = networkFor(s);
  /* Once a QID is confirmed it brings its spelling with it: the name and the
     entity have to agree, or the pair says two different things. So the stored
     entry carries both, and is keyed on the name as proposed here — that is the
     string the next site of this network arrives with. */
  const put = (k, v) => {
    if (!v) return;
    const hit = WD_KEYS.has(k) ? recallWikidata(v) : null;
    t[k] = hit?.label || v;
    if (hit) t[`${k}:wikidata`] = hit.qid;
  };
  put("operator", net.operator);
  put("brand", net.brand);
  put("network", net.network);

  /* The published ids for this site, in the registers OSM keeps a tag for.
     They earn their place by saying which record this node answers, so a later
     pass can see the site is mapped rather than offer it up again, and anyone
     reviewing the edit can read the source row it came from.

     `refs` is AFDC's numbering whichever source the site itself came from: the
     board takes Tesla, Electrify America and IONNA from better sources, but
     AFDC lists those places too and the merge now carries its ids across rather
     than dropping them. Where several AFDC records were collapsed into one site
     — 16% of them — every id is listed, semicolon-separated: all of them
     describe this station, and keeping only the first would leave the rest
     looking unmapped.

     `ref:supercharge_info` is the same idea in supercharge.info's own register,
     which is a different numbering and so a different tag. 2,929 US elements
     carry it, against 2,543 for `ref:afdc`.

     No `ref:plugshare`. It is a real tag on 1,423 US elements, but not one of
     the board's four sources publishes a PlugShare id, and a ref nobody can
     check is worse than no ref. */
  if (s.refs?.length) t["ref:afdc"] = s.refs.join(";");
  if (s.sc) t["ref:supercharge_info"] = String(s.sc);

  /* No `name`. A charging station is identified by who runs it, not by a name
     of its own, and the names these sources carry are the host business —
     "Walmart 1234" — or a location descriptor Tesla uses internally, "Jean,
     NV". Neither is signage on the thing itself. The reported name is still
     shown on the card as context; it just is not a tag. */

  if (s.ports > 0) t.capacity = String(s.ports);

  /* Per-connector counts where the source actually breaks them down. All the
     Places publishes one feature per charger for EA, IONNA states its mix
     outright, and supercharge.info counts stalls by plug — so those give real
     numbers rather than `yes`. AFDC only ever lists which connector types are
     present alongside one total, so its sites can be split no further than a
     single type taking the whole count. */
  const counted = Object.entries(s.sockets || {}).filter(([, n]) => Number(n) > 0);
  if (counted.length) {
    for (const [k, n] of counted) t[`socket:${k}`] = String(n);
  } else {
    let sockets = [...new Set((s.conn || []).map((c) => SOCKET[c]).filter(Boolean))];
    if (!sockets.length && net.sockets) sockets = net.sockets;
    for (const k of sockets) {
      t[`socket:${k}`] = sockets.length === 1 && s.ports > 0 ? String(s.ports) : "yes";
    }
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s.open || "")) t.start_date = s.open;
  return t;
}

/* ------------------------------------------------------- upgrading a node

   93% of US charging stations in OSM are a single node — 13,158 of them against
   987 ways. A node is a fine answer for a two-stall car park and a poor one for
   a 24-stall site that covers half an acre: it cannot say where the site ends,
   and it leaves the stalls unmapped, so nothing downstream can route to one or
   count them.

   This queue is the other half of the board's job. The first mode asks "is this
   site on the map at all"; this one asks "is what is on the map as good as what
   we know". It only ever offers sites that are already mapped, as a bare node,
   where AFDC has told us how many units stand there.

   What it cannot do is place them for you. AFDC publishes a unit breakdown for
   every site — how many pedestals, each one's connectors and power — but no
   coordinates for any of it, so the counts come from the data and the positions
   come from your eyes on the imagery. That division is the whole design: the
   panel says what should be there, you say where. */

/* `CONN_SOCKET` and `DC_SOCKET` live in app.js: the board exports sockets too,
   and one vocabulary that both files read beats two that can drift apart. */

/* Numbers that OSM wants a unit on. Written through this rather than by
   template so a value that already carries one does not end up "600 A A", and
   so a bare number inherited from a node somebody tagged by hand gets the unit
   it was always missing. */
const withUnit = (v, unit) => {
  const n = String(v ?? "").trim().replace(/\s*[a-zA-Z]+\s*$/, "").trim();
  return n === "" ? null : `${n} ${unit}`;
};
const UNIT_OF = { output: "kW", current: "A", voltage: "V" };

/* Bring any socket measurement already on an element up to the same standard.
   The station being replaced may carry years of somebody else's tagging, and
   half of it predates anyone caring about units. */
function normaliseUnits(tags) {
  const out = { ...tags };
  for (const [k, v] of Object.entries(out)) {
    const m = /^socket:[a-z0-9_]+:(output|current|voltage)$/.exec(k);
    if (!m) continue;
    const fixed = withUnit(v, UNIT_OF[m[1]]);
    if (fixed) out[k] = fixed; else delete out[k];
  }
  return out;
}

// how many sockets one AFDC unit carries
const kindSockets = (kind) =>
  Object.entries(kind.conn || {}).reduce((a, [k, n]) => a + (CONN_SOCKET[k] ? n : 0), 0);

/* What the site holds, in OSM's vocabulary: every socket AFDC accounts for, and
   the powers each connector is offered at.

   AFDC publishes totals, and totals do not say how the hardware is arranged.
   Four CCS sockets is two twin-cable cabinets or four singles — or four
   cabinets each pairing CCS with NACS — and nothing in the feed distinguishes
   them. Only somebody looking at the site can. So this works out what must be
   accounted for, and the placing is left to say how it is grouped. */
function siteSockets(units) {
  const total = {}, powers = {};
  for (const u of units || []) {
    for (const [k, n] of Object.entries(u.conn || {})) {
      const key = CONN_SOCKET[k];
      if (!key) continue;
      total[key] = (total[key] || 0) + n * u.n;
      if (u.kw) (powers[key] ||= new Set()).add(u.kw);
    }
  }
  return { total, powers: Object.fromEntries(
    Object.entries(powers).map(([k, v]) => [k, [...v].sort((a, b) => b - a)])) };
}

// sockets already accounted for by the points on the map and the ones just placed
function socketsDone(placed, existing) {
  const out = {};
  for (const p of placed) {
    for (const [key, n] of Object.entries(p.cfg.conn)) if (n) out[key] = (out[key] || 0) + n;
  }
  for (const o of existing) {
    for (const [k, v] of Object.entries(o.tags || {})) {
      const m = /^socket:([a-z0-9_]+)$/.exec(k);
      if (m) out[m[1]] = (out[m[1]] || 0) + (parseInt(v, 10) || 0);
    }
  }
  return out;
}

/* A starting configuration: one of whichever connector the site has most of, at
   its highest power. The commonest cabinet is a single cable, so that is the
   guess that needs the least correcting. */
function defaultCfg(units) {
  const { total, powers } = siteSockets(units);
  const first = Object.entries(total).sort((a, b) => b[1] - a[1])[0];
  if (!first) return { conn: {}, kw: {} };
  return { conn: { [first[0]]: 1 }, kw: { [first[0]]: powers[first[0]]?.[0] ?? null } };
}

const cfgSockets = (cfg) => Object.values(cfg.conn).reduce((a, n) => a + n, 0);
/* Power is per connector, not per cabinet. A pedestal offering CCS at 120 kW
   and a type 1 lead at 6.6 kW is one cabinet with two very different cables,
   and one number for both would be wrong about at least one of them. */
const cfgLabel = (cfg) => {
  const bits = Object.entries(cfg.conn).filter(([, n]) => n)
    .map(([k, n]) => `${n}× ${k}${cfg.kw?.[k] ? ` @ ${cfg.kw[k]} kW` : ""}`);
  return bits.length ? bits.join(" + ") : "nothing selected";
};

/* Tags for one dispenser — the cabinet somebody walks up to, which is not the
   same thing as a socket. AFDC counts sockets and calls them units, so a site
   with six twin-cable dispensers arrives here as "12 units"; `per` is how many
   of those sockets are on one cabinet, and it is the mapper's to set, because
   only they have stood in the car park.

   Power hangs off the socket, not the station. `charging_station:output`
   describes a site as a whole, so on a node that is one dispenser it is the
   wrong scope — `socket:<type>:output` is the key that says this cable
   delivers this much. */
function pointTags(cfg, gear = null, from = null) {
  const t = { man_made: "charge_point" };
  let cables = 0;
  let dc = false;
  for (const [key, n] of Object.entries(cfg.conn || {})) {
    if (!n) continue;
    t[`socket:${key}`] = String(n);
    if (cfg.kw?.[key]) t[`socket:${key}:output`] = withUnit(cfg.kw[key], "kW");
    // AFDC has neither of these; they come off the remembered profile for this
    // cabinet, because a model number pins them down and a site never will
    const amps = withUnit(gear?.current, "A");
    const volts = withUnit(gear?.voltage, "V");
    if (amps) t[`socket:${key}:current`] = amps;
    if (volts) t[`socket:${key}:voltage`] = volts;
    cables += n;
    if (DC_SOCKET.has(key)) dc = true;
  }
  t.capacity = String(cables);
  // DC is mains frequency zero — the one technical fact about a fast charger
  // that never needs looking up
  if (dc) t.frequency = "0";
  return { ...t, ...gearTags(gear), ...inherited(from) };
}

/* Brand and operator belong on the dispenser as much as on the site, and the
   node being replaced already carries them — so they are copied down rather
   than typed again. Only these four: everything else on a station describes the
   site (addresses, opening hours, payment) and would be a lie on a cabinet. */
function inherited(tags) {
  if (!tags) return {};
  const out = {};
  for (const k of ["brand", "brand:wikidata", "operator", "operator:wikidata"]) {
    if (tags[k]) out[k] = tags[k];
  }
  return out;
}

/* Who made the cabinet. Worth asking for because it is the part of a charge
   point that does not change: connectors and power get revised, a Tritium PKM
   stays a Tritium PKM, and it is visible in imagery and on the unit itself in
   a way that kilowatts never are. Remembered per network, since an operator
   buys one model by the pallet. */
function gearTags(gear) {
  if (!gear) return {};
  const t = {};
  if (gear.manufacturer) t.manufacturer = gear.manufacturer;
  if (gear.model) t.model = gear.model;
  // a Q-id or nothing: a half-typed one is worse than none
  if (gear.brand) t.brand = gear.brand;
  if (/^Q\d+$/.test(gear.mfgQ || "")) t["manufacturer:wikidata"] = gear.mfgQ;
  if (/^Q\d+$/.test(gear.modelQ || "")) t["model:wikidata"] = gear.modelQ;
  if (/^Q\d+$/.test(gear.brandQ || "")) t["brand:wikidata"] = gear.brandQ;
  return t;
}

const BLANK_GEAR = { manufacturer: "", mfgQ: "", model: "", modelQ: "",
                     brand: "", brandQ: "", current: "", voltage: "" };

/* Look a name up on Wikidata rather than making somebody go and find a Q-id.

   wbsearchentities is the same endpoint the Wikidata site's own box uses; it
   allows cross-origin reads, so this needs no key and no proxy. Results are
   labelled with their description because "Tritium" is a company, a hydrogen
   isotope and a watch coating, and the description is the only thing that tells
   them apart at a glance. */
async function wikidataSearch(term) {
  const url = "https://www.wikidata.org/w/api.php?action=wbsearchentities" +
    `&format=json&origin=*&language=en&uselang=en&type=item&limit=7&search=${encodeURIComponent(term)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Wikidata answered ${res.status}`);
  const body = await res.json();
  return (body.search || []).map((r) => ({ id: r.id, label: r.label || r.id, desc: r.description || "" }));
}

/* A library of cabinets, kept apart from the per-network memory.

   A model is a product, not a setting: an Alpitronic HYC400 is the same box
   whether bp pulse or EVgo bought it, and its manufacturer, wikidata ids,
   current and voltage travel with it. So the library holds those and nothing
   else — `brand` is whose forecourt it stands on, which changes site to site,
   and picking a model must never overwrite it. */
const MODEL_KEYS = ["manufacturer", "mfgQ", "model", "modelQ", "current", "voltage"];
const models = () => store.get(K.models, {}) || {};
const modelLabel = (g) => [g.manufacturer, g.model].filter(Boolean).join(" ").trim();

function saveModel(gear) {
  const label = modelLabel(gear);
  if (!label) return null;
  const keep = {};
  for (const k of MODEL_KEYS) if (gear[k]) keep[k] = gear[k];
  store.set(K.models, { ...models(), [label]: keep });
  return label;
}
const dropModel = (label) => {
  const all = { ...models() };
  delete all[label];
  store.set(K.models, all);
};
// the cabinet's details replace what is there; whose site it is does not
const applyModel = (gear, saved) => ({ ...gear, ...BLANK_MODEL, ...saved });
const BLANK_MODEL = Object.fromEntries(MODEL_KEYS.map((k) => [k, ""]));

const gearFor = (net) => ({ ...BLANK_GEAR, ...((store.get(K.gear, {}) || {})[net] || {}) });
const rememberGear = (net, gear) => {
  if (!net || !(gear.manufacturer || gear.model)) return;
  store.set(K.gear, { ...(store.get(K.gear, {}) || {}), [net]: gear });
};

const GEAR_FIELDS = [
  ["manufacturer", "Manufacturer", "Alpitronic", "name"],
  ["mfgQ", "↳ wikidata", "Q…", "id"],
  ["model", "Model", "HYC400", "name"],
  ["modelQ", "↳ wikidata", "Q…", "id"],
  ["brand", "Brand", "bp pulse", "name"],
  ["brandQ", "↳ wikidata", "Q…", "id"],
  ["current", "Current (A)", "600", "num"],
  ["voltage", "Voltage (V)", "1000", "num"],
];
// which name field a wikidata field is the id for
const NAME_OF = { mfgQ: "manufacturer", modelQ: "model", brandQ: "brand" };

/* One line of what is set, so the panel does not carry eight inputs at rest. */
function gearSummary(g) {
  const bits = [];
  if (g.manufacturer || g.model) bits.push([g.manufacturer, g.model].filter(Boolean).join(" "));
  if (g.brand) bits.push(g.brand);
  const elec = [g.current && `${g.current} A`, g.voltage && `${g.voltage} V`].filter(Boolean).join(" / ");
  if (elec) bits.push(elec);
  const ids = [g.mfgQ, g.modelQ, g.brandQ].filter((q) => /^Q\d+$/.test(q || "")).length;
  if (ids) bits.push(`${ids} wikidata id${ids === 1 ? "" : "s"}`);
  return bits.join(" · ");
}

/* What the station itself should say: every socket on the site added up, and a
   capacity to match. The old path copied the node's tags to the way untouched,
   which left a site claiming whatever single number was on the node while the
   points beneath it said something else.

   Counted from AFDC's units rather than from the points just placed, because
   the two are not the same thing. Somebody who maps six of a site's ten
   cabinets today has not made the site smaller, and a station that shrinks to
   match how far its mapper got is worse than one that states the site. */
function stationTags(base, units) {
  const t = normaliseUnits(base);
  const totals = {}, kw = {};
  let cables = 0, dc = false;
  for (const u of units) {
    for (const [k, n] of Object.entries(u.conn || {})) {
      const key = CONN_SOCKET[k];
      if (!key) continue;
      totals[key] = (totals[key] || 0) + n * u.n;
      // the strongest of a kind, which is what a site is judged on
      if (u.kw && u.kw > (kw[key] || 0)) kw[key] = u.kw;
      cables += n * u.n;
      if (DC_SOCKET.has(key)) dc = true;
    }
  }
  for (const [key, n] of Object.entries(totals)) {
    t[`socket:${key}`] = String(n);
    if (kw[key]) t[`socket:${key}:output`] = withUnit(kw[key], "kW");
  }
  if (cables) t.capacity = String(cables);
  if (dc) t.frequency = "0";
  return t;
}

/* Fill gaps on the station from what the mapper typed, without overwriting
   anything it already says. A site that named its brand but never linked it is
   the common case, and the link is the half that machines can use. */
function fillIdentity(tags, gear) {
  const out = { ...tags };
  for (const [k, v] of Object.entries(gearTags(gear))) {
    if (k === "brand" || k === "brand:wikidata") { if (!out[k]) out[k] = v; }
  }
  return out;
}

/* Everything mapped as a bare node that the board knows more about than the map
   does. `osmExt` is how far the mapped element reaches — zero means a node, and
   a way or relation has already been drawn by somebody. */
function upgradePool() {
  if (!MERGED) return [];
  const done = new Set(store.get(K.upDone, []));
  const skip = new Set(store.get(K.upSkip, []));
  return MERGED.sites
    .filter((s) => s.osm && !s.hostOnly && s.osmId?.[0] === "n" && s.units?.length)
    .filter((s) => !VIEW.net || s.net === VIEW.net)
    .filter((s) => !isRemembered(done, s) && !isRemembered(skip, s));
}

function upgrades() {
  return upgradePool()
    .filter((s) => !VIEW.state || s.state === VIEW.state)
    .filter((s) => openedWithin(s, VIEW.impOpen))
    // the widest gap between what is mapped and what is there, first
    .sort((a, b) => unitCount(b) - unitCount(a));
}

const unitCount = (s) => (s.units || []).reduce((a, u) => a + u.n, 0);

/* Clicks land on the map while a tool is up: corners for the outline, one per
   pedestal for the charge points. Returning true tells the map this click was
   consumed, so it does not also move the pin. */
function upgradeClick(ll) {
  const u = CUR.up;
  if (!u?.tool) return false;
  if (u.tool === "outline") u.ring.push(ll);
  // the configuration is copied, not referenced: changing it for the next
  // cabinet must not rewrite the one just placed
  else u.pts.push({ ...ll, cfg: { conn: { ...u.cfg.conn }, kw: { ...u.cfg.kw } } });
  paintSide();
  MAP.schedule();
  return true;
}

/* The ring as it will be uploaded. Three clicks make a rectangle — the fourth
   corner of a car park is wherever the first three say it is — and four or more
   are squared up unless that has been turned off. */
const upgradeRing = (u) =>
  !u || u.ring.length < 3 ? (u?.ring || []) : shapeFor(u.ring, u.square);

function drawUpgrade(ctx, map) {
  const u = CUR.up;
  if (!u) return;
  const ring = upgradeRing(u);
  if (ring.length) {
    ctx.beginPath();
    ring.forEach((p, i) => { const [x, y] = map.toPx(p.lat, p.lon); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    if (ring.length > 2) ctx.closePath();
    ctx.fillStyle = "rgba(168,81,42,.18)";
    ctx.strokeStyle = cssv("--accent");
    ctx.lineWidth = 2;
    if (ring.length > 2) ctx.fill();
    ctx.stroke();
    // the raw clicks, so it is obvious which corners squaring moved
    for (const p of u.ring) {
      const [x, y] = map.toPx(p.lat, p.lon);
      ctx.beginPath(); ctx.arc(x, y, 3.5, 0, 6.284);
      ctx.fillStyle = cssv("--accent"); ctx.fill();
    }
  }
  u.pts.forEach((p, i) => {
    const [x, y] = map.toPx(p.lat, p.lon);
    ctx.beginPath(); ctx.arc(x, y, 8, 0, 6.284);
    ctx.fillStyle = "rgba(0,0,0,.45)"; ctx.fill();
    ctx.strokeStyle = cssv("--s1"); ctx.lineWidth = 2.2; ctx.stroke();
    ctx.fillStyle = cssv("--s1");
    ctx.font = "600 10px 'IBM Plex Mono', monospace";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(i + 1), x, y);
  });
  /* Charge points somebody has already mapped: drawn so a new one is not put on
     top of one, and draggable, so a node sitting in the wrong bay can be put
     right while you are here rather than left for another trip. */
  for (const o of map.others) {
    const [x, y] = map.toPx(o.lat, o.lon);
    const grabbable = o.kind === "point" && o.type === "node";
    if (o.moved) {
      const h = map.toPx(o.home.lat, o.home.lon);
      ctx.strokeStyle = cssv("--s4");
      ctx.setLineDash([4, 4]); ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(h[0], h[1]); ctx.lineTo(x, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(h[0], h[1], 3.5, 0, 6.284); ctx.stroke();
    }
    ctx.strokeStyle = cssv(o.moved ? "--accent" : "--s3");
    ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.arc(x, y, 9, 0, 6.284); ctx.stroke();
    if (grabbable) {
      ctx.fillStyle = cssv(o.moved ? "--accent" : "--s3");
      ctx.beginPath(); ctx.arc(x, y, 2.2, 0, 6.284); ctx.fill();
    }
  }
}

/* The choice between the two answers a site can be given. Only meaningful for
   a site that is not on the map yet — an upgrade is by definition already a
   node, and turning it back into one is not an improvement. */
function shapeSwitch(u) {
  if (MODE() === "upgrade") return "";
  return `<div class="imp-tools imp-shape">
    <button class="imp-chip${u.shape !== "area" ? " is-on" : ""}" data-shape="node">A single node</button>
    <button class="imp-chip${u.shape === "area" ? " is-on" : ""}" data-shape="area">An area with charge points</button>
  </div>`;
}

function bindShapeSwitch(side) {
  side.querySelectorAll("[data-shape]").forEach((b) => {
    b.onclick = () => {
      if ((CUR.up?.shape || "node") === b.dataset.shape) return;
      /* Re-running `show` rather than flipping a flag: the two answers want
         different things on the map — one a draggable pin, the other a blank
         canvas to trace on — and half-switched state is how a pin ends up
         uploaded alongside an outline. */
      CUR.up = { shape: b.dataset.shape };
      show();
    };
  });
}

function upgradeCard(side) {
  const s = CUR.site, u = CUR.up;
  const ring = upgradeRing(u);
  const placed = u.pts.length;
  const already = (MAP.others || []).filter((o) => o.kind === "point");
  const nudged = already.filter((o) => o.moved);
  const { total, powers } = siteSockets(s.units);
  const done = socketsDone(u.pts, already);
  // what is still unaccounted for, connector by connector
  const left = Object.fromEntries(Object.entries(total)
    .map(([k, n]) => [k, n - (done[k] || 0)]).filter(([, n]) => n !== 0));
  const balanced = !Object.keys(left).length;
  // how the cabinets placed so far are grouped
  const groups = new Map();
  for (const pt of u.pts) groups.set(cfgLabel(pt.cfg), (groups.get(cfgLabel(pt.cfg)) || 0) + 1);
  // a power row per selected connector that is offered at more than one
  const kwRows = Object.keys(u.cfg.conn)
    .filter((k) => u.cfg.conn[k] && (powers[k] || []).length > 1)
    .map((k) => [k, powers[k]]);

  side.innerHTML = `
    <div class="imp-card imp-card--site">
      <h3>${esc(s.name || "Unnamed site")}</h3>
      <div class="imp-net">${brandMark(s.net)}${esc(s.net)}</div>
      <dl class="imp-facts">
        <dt>Ports</dt><dd>${nf(s.ports)}</dd>
        <dt>On the map</dt><dd class="mono">${s.osmId
          ? `${esc(s.osmId)}${s.osmCap != null ? ` · capacity ${nf(s.osmCap)}` : " · no capacity"}`
          : "nothing yet"}</dd>
        <dt>Source</dt><dd>${esc(s.src)}</dd>
      </dl>
    </div>

    <div class="imp-poi">
      <b>AFDC accounts for</b>
      <div class="imp-balance">
        ${Object.entries(total).map(([key, n]) => {
          const gone = done[key] || 0;
          return `<div class="imp-balance-row${gone === n ? " is-done" : gone > n ? " is-over" : ""}">
            <span class="mono">${esc(key)}</span>
            <span class="mono">${nf(gone)} / ${nf(n)}${
              powers[key]?.length > 1 ? ` · ${powers[key].join("/")} kW` : ""}</span>
          </div>`;
        }).join("")}
      </div>
      ${(() => {
        /* Two sources counting the same forecourt. AFDC publishes a connector
           breakdown; All the Places and supercharge.info publish a stall count
           and are the reason those networks are overridden at all. Where the
           two disagree the panel says so rather than picking one — the mapper
           is the one who can see which is right, and neither number is worth
           hiding to keep the arithmetic tidy. */
        const sockets = Object.values(total).reduce((a, n) => a + n, 0);
        if (!s.ports || !sockets || sockets === s.ports || s.src === "AFDC") return "";
        return `<p class="imp-note imp-known">${esc(s.src)} counts ${nf(s.ports)} ports here;
           AFDC's breakdown accounts for ${nf(sockets)}. The connectors below are AFDC's, the
           port count is ${esc(s.src)}'s. Place what the imagery actually shows.</p>`;
      })()}
      <p class="imp-note">${balanced ? `Every socket accounted for.`
        : `Still to place: ${esc(Object.entries(left).map(([k, n]) =>
             n > 0 ? `${nf(n)} ${k}` : `${nf(-n)} ${k} too many`).join(", "))}.`}${
        already.length ? ` ${nf(already.length)} already mapped, counted in. Drag a ring onto its
        actual bay.` : ""}</p>

      <div class="imp-cfg">
        <div class="ctl-label">This dispenser carries</div>
        ${Object.keys(total).map((key) => `
          <div class="imp-cfg-row">
            <span class="mono">${esc(key)}</span>
            <span class="imp-step">
              <button class="imp-chip" data-conn="${esc(key)}" data-step="-1"${
                (u.cfg.conn[key] || 0) ? "" : " disabled"}>−</button>
              <b class="mono">${nf(u.cfg.conn[key] || 0)}</b>
              <button class="imp-chip" data-conn="${esc(key)}" data-step="1">+</button>
            </span>
          </div>`).join("")}
        ${kwRows.map(([key, kws]) => `<div class="imp-cfg-row">
          <span class="ctl-label">${esc(key)} power</span>
          <span class="imp-seg">${kws.map((kw) =>
            `<button class="seg-btn${u.cfg.kw?.[key] === kw ? " is-on" : ""}"
                     data-kw="${kw}" data-kwfor="${esc(key)}">${kw}</button>`).join("")}</span>
        </div>`).join("")}
      </div>
      <p class="imp-note">Four CCS sockets is two twin cabinets or four singles, and AFDC cannot
         say which. Set what one cabinet carries, place those, then change it for the next kind —
         each point keeps the layout it was placed with.</p>

      ${groups.size ? `<div class="imp-balance">${[...groups].map(([label, n]) =>
        `<div class="imp-balance-row"><span>${nf(n)} × ${esc(label)}</span></div>`).join("")}</div>` : ""}

      ${nudged.length ? `<div class="imp-moved">
        ${nudged.map((o) => `<div class="imp-moved-row">
          <a href="${ENV().web}/node/${esc(o.id)}" target="_blank" rel="noopener" class="mono">node ${esc(o.id)}</a>
          <button class="imp-chip" data-home="${esc(o.id)}" title="Put it back where OpenStreetMap has it">
            moved ${nf(Math.round(metres(o.home, o)))} m</button>
        </div>`).join("")}
      </div>` : ""}

    </div>

    <div class="imp-poi">
      <div class="imp-poi-row">
        <b>What these dispensers are</b>
        <button class="imp-chip" id="up-gear-open" aria-expanded="${u.open ? "true" : "false"}">${
          u.open ? "Done" : gearSummary(u.gear) ? "Edit" : "Add"}</button>
      </div>
      ${!u.open ? `<p class="imp-note">${gearSummary(u.gear)
        ? esc(gearSummary(u.gear))
        : `Nothing set — the dispensers go in with sockets and power only.`}</p>
        ${Object.keys(models()).length ? `<div class="imp-models">
          ${Object.keys(models()).sort().map((label) => `
            <button class="imp-chip${modelLabel(u.gear) === label ? " is-on" : ""}"
                    data-model="${esc(label)}">${esc(label)}</button>`).join("")}
        </div>` : ""}` : `
        <div class="imp-gear">
          ${GEAR_FIELDS.map(([key, label, ph, q]) => {
            const v = u.gear[key] || "";
            const bad = q === "id" && v && !/^Q\d+$/.test(v);
            return `<label class="${q === "id" ? "imp-gear-q" : ""}">
              <span class="ctl-label">${esc(label)}</span>
              <span class="imp-gear-in">
                <input data-gear="${key}" value="${esc(v)}" placeholder="${esc(ph)}"
                       autocomplete="off"${bad ? ' class="is-bad"' : ""}>
                ${q === "id" ? `<button class="imp-chip" data-find="${key}"
                   title="Search Wikidata for this">find</button>` : ""}
              </span></label>`;
          }).join("")}
        </div>
        ${u.hits ? `<div class="imp-hits">
          ${u.hits.busy ? `<p class="imp-note">Searching Wikidata…</p>`
            : u.hits.error ? `<p class="imp-note">${esc(u.hits.error)}</p>`
            : !u.hits.rows.length ? `<p class="imp-note">Nothing on Wikidata for that name.</p>`
            : u.hits.rows.map((r) => `<button class="imp-hit" data-take="${esc(r.id)}" data-for="${esc(u.hits.key)}">
                <b>${esc(r.label)}</b> <span class="mono">${esc(r.id)}</span>
                ${r.desc ? `<span class="imp-hit-desc">${esc(r.desc)}</span>` : ""}</button>`).join("")}
        </div>` : ""}
        <div class="imp-poi-acts">
          <button class="imp-chip" id="up-model-save"${modelLabel(u.gear) ? "" : " disabled"}>${
            models()[modelLabel(u.gear)] ? "Update" : "Save"} ${
            modelLabel(u.gear) ? `“${esc(modelLabel(u.gear))}”` : "as a model"}</button>
          ${models()[modelLabel(u.gear)]
            ? `<button class="imp-chip" id="up-model-drop">Forget it</button>` : ""}
        </div>
        <p class="imp-note">Saving keeps the cabinet — make, model, ids, current, voltage — so the
           next site is one click. Brand stays out of it: the same box turns up on other people's
           forecourts. Current and voltage are the cabinet's, not the site's.</p>`}
    </div>

    ${shapeSwitch(u)}

    <div class="imp-tools">
      <button class="imp-chip${u.tool === "outline" ? " is-on" : ""}" data-tool="outline">Outline the site</button>
      <button class="imp-chip${u.tool === "points" ? " is-on" : ""}" data-tool="points"${
        cfgSockets(u.cfg) ? "" : " disabled"}>Place charge points</button>
    </div>

    ${u.tool === "outline" ? `
      <div class="imp-warn">
        <b>Tracing</b>
        <p class="imp-note">${u.ring.length < 3
          ? `Click the corners of the site — ${3 - u.ring.length} more before it is a shape.`
          : `${nf(u.ring.length)} corners${u.square ? ", squared" : ", exactly as clicked"}.`}</p>
        <div class="imp-poi-acts">
          <button class="imp-chip${u.square ? " is-on" : ""}" id="up-square" aria-pressed="${u.square}">Square up</button>
          <button class="imp-chip" id="up-undo"${u.ring.length ? "" : " disabled"}>Undo</button>
          <button class="imp-chip" id="up-clear"${u.ring.length ? "" : " disabled"}>Clear</button>
        </div>
        <p class="imp-note">${u.square
          ? `Right angles forced; three corners means a rectangle. Turn it off for an L, a wedge,
             or however the site actually runs.`
          : `Every corner stays where you put it.`}</p>
      </div>` : ""}

    ${u.tool === "points" ? `
      <div class="imp-warn">
        <b>Placing ${esc(cfgLabel(u.cfg))}</b>
        <p class="imp-note">Click each cabinet. ${nf(placed)} placed${
          balanced ? " — every socket accounted for" : ""}.</p>
        <div class="imp-poi-acts">
          <button class="imp-chip" id="up-undo"${placed ? "" : " disabled"}>Undo</button>
          <button class="imp-chip" id="up-clear"${placed ? "" : " disabled"}>Clear</button>
        </div>
      </div>` : ""}

    ${ring.length > 2 && s.osmId ? `
      <div class="imp-poi">
        <b>What happens to ${esc(s.osmId)}</b>
        <p class="imp-note">The station tags move to the outline. It cannot stay as it is —
           that would be two <span class="mono">amenity=charging_station</span> at one site.</p>
        <div class="imp-poi-acts">
          <button class="imp-chip${u.keep === "point" ? " is-on" : ""}" data-keep="point">Make it a charge point</button>
          <button class="imp-chip${u.keep === "delete" ? " is-on" : ""}" data-keep="delete">Delete it</button>
        </div>
      </div>` : ""}

    <div class="imp-keys">
      <span>If the imagery predates the site, draw nothing.</span>
      <span><kbd>Q</kbd> squaring · <kbd>Z</kbd> undo · <kbd>S</kbd> skip</span>
    </div>

    ${CUR.log?.length ? `<div class="imp-h">Changed this session</div>
      <div class="imp-log">${CUR.log.map((r) =>
        `<div><a href="${ENV().web}/${r.type || "node"}/${r.id}" target="_blank" rel="noopener">${esc(r.name)}</a>
          <span class="mono">#${r.cs}</span></div>`).join("")}</div>` : ""}

    <div class="imp-error" id="imp-error" hidden></div>
    <div class="imp-actions">
      <button class="imp-primary" id="imp-up-save"${ring.length > 2 || placed || nudged.length ? "" : " disabled"}>${
        [ring.length > 2 ? "Draw the site" : null,
         placed ? `add ${nf(placed)} point${placed === 1 ? "" : "s"}` : null,
         nudged.length ? `move ${nf(nudged.length)}` : null].filter(Boolean).join(" and ")
          .replace(/^./, (c) => c.toUpperCase()) || "Nothing drawn yet"}</button>
      <button class="imp-ghost" id="imp-skip">Skip</button>
    </div>`;

  bindShapeSwitch(side);
  side.querySelectorAll("[data-tool]").forEach((b) => {
    b.onclick = () => { u.tool = u.tool === b.dataset.tool ? null : b.dataset.tool; paintSide(); };
  });
  side.querySelectorAll("[data-conn]").forEach((b) => {
    b.onclick = () => {
      const key = b.dataset.conn;
      const next = Math.max(0, (u.cfg.conn[key] || 0) + Number(b.dataset.step));
      const conn = { ...u.cfg.conn, [key]: next };
      const kw = { ...u.cfg.kw };
      // a connector just switched on takes the best power the site offers it
      if (next && kw[key] == null) kw[key] = siteSockets(CUR.site.units).powers[key]?.[0] ?? null;
      if (!next) delete kw[key];
      u.cfg = { conn, kw };
      paintSide();
    };
  });
  side.querySelectorAll("[data-kw]").forEach((b) => {
    b.onclick = () => {
      u.cfg = { ...u.cfg, kw: { ...u.cfg.kw, [b.dataset.kwfor]: Number(b.dataset.kw) } };
      paintSide();
    };
  });
  side.querySelectorAll("[data-home]").forEach((b) => {
    b.onclick = () => {
      const o = (MAP.others || []).find((x) => String(x.id) === b.dataset.home);
      if (!o) return;
      o.lat = o.home.lat; o.lon = o.home.lon; o.moved = false;
      paintSide(); MAP.schedule();
    };
  });
  side.querySelectorAll("[data-model]").forEach((b) => {
    b.onclick = () => {
      const saved = models()[b.dataset.model];
      if (!saved) return;
      // clicking the one already in force clears it, so a wrong pick is undoable
      u.gear = modelLabel(u.gear) === b.dataset.model
        ? { ...u.gear, ...BLANK_MODEL }
        : applyModel(u.gear, saved);
      paintSide();
    };
  });
  side.querySelector("#up-model-save")?.addEventListener("click", () => {
    saveModel(u.gear);
    paintSide();
  });
  side.querySelector("#up-model-drop")?.addEventListener("click", () => {
    dropModel(modelLabel(u.gear));
    paintSide();
  });
  side.querySelector("#up-gear-open")?.addEventListener("click", () => {
    u.open = !u.open;
    u.hits = null;
    paintSide();
  });
  side.querySelectorAll("[data-gear]").forEach((el) => {
    el.oninput = () => { u.gear = { ...u.gear, [el.dataset.gear]: el.value.trim() }; };
    // the Q-id fields only complain once you have moved on from them
    el.onblur = () => paintSide();
  });
  side.querySelectorAll("[data-find]").forEach((b) => {
    b.onclick = async () => {
      const key = b.dataset.find;
      const term = u.gear[NAME_OF[key]];
      if (!term) { u.hits = { key, rows: [], error: `Type a ${NAME_OF[key]} first.` }; return paintSide(); }
      u.hits = { key, rows: [], busy: true };
      paintSide();
      try {
        u.hits = { key, rows: await wikidataSearch(term) };
      } catch (e) {
        u.hits = { key, rows: [], error: e.message };
      }
      paintSide();
    };
  });
  side.querySelectorAll("[data-take]").forEach((b) => {
    b.onclick = () => {
      u.gear = { ...u.gear, [b.dataset.for]: b.dataset.take };
      u.hits = null;
      paintSide();
    };
  });
  side.querySelectorAll("[data-keep]").forEach((b) => {
    b.onclick = () => { u.keep = b.dataset.keep; paintSide(); };
  });
  side.querySelector("#up-square")?.addEventListener("click", () => { u.square = !u.square; paintSide(); MAP.schedule(); });
  side.querySelector("#up-undo")?.addEventListener("click", () => undoUpgrade());
  side.querySelector("#up-clear")?.addEventListener("click", () => {
    if (u.tool === "outline") u.ring = []; else u.pts = [];
    paintSide(); MAP.schedule();
  });
  side.querySelector("#imp-up-save").onclick = saveUpgrade;
  side.querySelector("#imp-skip").onclick = () => skip("skip");
}

function undoUpgrade() {
  const u = CUR.up;
  if (!u) return;
  if (u.tool === "outline") u.ring.pop(); else u.pts.pop();
  paintSide();
  MAP.schedule();
}

/* Create several nodes in one go. `uploadNode` answers for the one-node case
   and re-reads nothing; a set of charge points is one edit and belongs in one
   <create>, or a half-placed site sits on the map between uploads. */
async function createNodes(points, cs) {
  const body = `<osmChange version="0.6" generator="${xesc(APP)} ${VERSION}"><create>` +
    points.map((p, i) =>
      `<node id="-${i + 1}" changeset="${cs}" lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">` +
      tagXml(cleanTags(p.tags)) + `</node>`).join("") +
    `</create></osmChange>`;
  const res = await osmFetch(`/api/0.6/changeset/${cs}/upload`, {
    method: "POST", headers: { "Content-Type": "text/xml" }, body,
  });
  const out = new DOMParser().parseFromString(await res.text(), "text/xml");
  return [...out.getElementsByTagName("node")].map((n) => n.getAttribute("new_id"));
}

/* Shift nodes that are already on the map to where the imagery says they are.

   Tags are untouched: this reads each node as it currently stands and changes
   only its position, so somebody else's careful socket tagging survives being
   nudged four metres onto its actual bay. One <modify> for the lot, because a
   row of dispensers is one correction. */
async function moveNodes(moves, cs) {
  const els = [];
  for (const m of moves) {
    const cur = await fetchElement("node", m.id);
    if (!cur.visible) continue;
    cur.el.setAttribute("lat", m.lat.toFixed(7));
    cur.el.setAttribute("lon", m.lon.toFixed(7));
    cur.el.setAttribute("changeset", cs);
    els.push(new XMLSerializer().serializeToString(cur.el));
  }
  if (!els.length) return 0;
  const body = `<osmChange version="0.6" generator="${xesc(APP)} ${VERSION}"><modify>` +
    els.join("") + `</modify></osmChange>`;
  const res = await osmFetch(`/api/0.6/changeset/${cs}/upload`, {
    method: "POST", headers: { "Content-Type": "text/xml" }, body,
  });
  if (!res.ok) throw new Error("could not move the existing charge points");
  return els.length;
}

/* Remove an element. The only place this tool deletes anything, and it is asked
   for explicitly per site — the alternative offered beside it keeps the node
   and retags it, which is what the button defaults to. */
async function deleteNode(type, id, cs) {
  const cur = await fetchElement(type, id);
  const el = cur.el;
  el.setAttribute("changeset", cs);
  const body = `<osmChange version="0.6" generator="${xesc(APP)} ${VERSION}"><delete>` +
    new XMLSerializer().serializeToString(el) + `</delete></osmChange>`;
  const res = await osmFetch(`/api/0.6/changeset/${cs}/upload`, {
    method: "POST", headers: { "Content-Type": "text/xml" }, body,
  });
  if (!res.ok) throw new Error(`could not delete ${type} ${id}`);
}

async function saveUpgrade() {
  const s = CUR.site, u = CUR.up;
  if (!s || !u || CUR.busy) return;
  const ring = upgradeRing(u);
  const drawing = ring.length > 2;
  const nudged = (MAP.others || []).filter((o) => o.kind === "point" && o.type === "node" && o.moved);
  if (!drawing && !u.pts.length && !nudged.length) return fail("Nothing drawn yet.");

  CUR.busy = true;
  const btn = $("imp-up-save");
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Reading the node…";
  let open = null;
  try {
    /* Read it now rather than trusting the snapshot. The node may have been
       turned into an area by somebody else since the last refresh, in which
       case drawing a second one is the opposite of an improvement. */
    // Only needed when something is being written onto the station: a pure
    // repositioning of other people's nodes has no business reading it.
    const node = s.osmId && (drawing || u.pts.length)
      ? await fetchElement("node", s.osmId.slice(1)) : null;
    if (drawing && node && node.tags.amenity !== "charging_station")
      throw new Error(`${s.osmId} is no longer a charging station — refresh and look again`);
    /* Nothing on the map yet, so the outline is the first thing this site gets
       and its tags are the ones the panel proposed rather than an existing
       node's. Same shape of edit, different starting point. */
    const base = node ? node.tags : cleanTags(CUR.tags || {});
    if (drawing && !Object.keys(base).length)
      throw new Error("Nothing here says what this is — add tags before drawing it.");

    btn.textContent = "Opening changeset…";
    const cs = (open = await createChangeset({
      created_by: `${APP} ${VERSION}`,
      comment: (drawing ? (node ? `Draw charging station as an area` : `Add charging station as an area`)
                : u.pts.length ? `Add charge points`
                : `Reposition charge points from imagery`) +
        `${base.brand ? ` (${base.brand})` : ""}${s.state ? ` in ${s.state}` : ""}`,
      source: CUR.layer ? CUR.layer.name : "aerial imagery",
      imagery_used: CUR.layer ? CUR.layer.name : "aerial imagery",
      "charge_board:lead": s.src,
    }));

    const log = [];
    let madeWay = null;
    if (drawing) {
      btn.textContent = "Drawing the site…";
      // the way inherits the node's tags exactly: this is a migration, not a
      // re-survey, and anything else the mapper wrote goes with it
      /* The station's own totals, not a copy of whatever single number the node
         carried. A site whose points say 6 × 2 sockets and whose way still says
         capacity=1 is worse than either alone. */
      const way = await createWay(ring, fillIdentity(stationTags(base, s.units), u.gear), cs);
      madeWay = way.id;
      log.push({ type: "way", id: way.id, cs, name: `${base.name || s.net} outline` });

      if (node) btn.textContent = u.keep === "delete" ? "Removing the node…" : "Retagging the node…";
      if (!node) { /* nothing to demote: this site had no element to begin with */ }
      else if (u.keep === "delete") {
        await deleteNode("node", s.osmId.slice(1), cs);
      } else {
        /* Demoted, not duplicated. Every station tag comes off and the node is
           left saying the one thing still true of it: there is charging
           equipment about here.

           Bare, with no socket detail. It is tempting to give it the site's
           commonest unit kind, but nobody knows which pedestal this node was —
           it was never a pedestal, it was the whole site — and a 70-unit car
           park would have it claiming to be one of the 56 AC posts. The points
           placed by hand below say which is which; this one only says it is
           equipment. */
        await replaceTags("node", s.osmId.slice(1), { man_made: "charge_point" }, cs, node.version);
      }
    }

    if (u.pts.length) {
      btn.textContent = `Adding ${u.pts.length} charge point${u.pts.length === 1 ? "" : "s"}…`;
      const ids = await createNodes(
        u.pts.map((p) => ({ lat: p.lat, lon: p.lon,
                            tags: pointTags(p.cfg, u.gear, base) })), cs);
      log.push({ type: "node", id: ids[0], cs,
                 name: `${u.pts.length} charge point${u.pts.length === 1 ? "" : "s"}` });
    }

    if (nudged.length) {
      btn.textContent = `Moving ${nudged.length} existing point${nudged.length === 1 ? "" : "s"}…`;
      await moveNodes(nudged.map((o) => ({ id: o.id, lat: o.lat, lon: o.lon })), cs);
      log.push({ type: "node", id: nudged[0].id, cs,
                 name: `${nudged.length} point${nudged.length === 1 ? "" : "s"} repositioned` });
      // they are where they belong now, so a later edit measures from here
      for (const o of nudged) { o.home = { lat: o.lat, lon: o.lon }; o.moved = false; }
    }

    await closeChangeset(cs);
    open = null;
    /* Remembered in whichever queue this was: a site added as an area is done
       as an unmapped site, not as a node wanting an upgrade. */
    if (MODE() === "upgrade") remember(K.upDone, s);
    else {
      remember(K.done, s);
      s.osm = true;
      s.osmDetail = true;
      // what was just made, so the board can link straight to it
      if (madeWay) { s.osmId = `w${madeWay}`; s.osmExt = 1; }
      DIRTY = true;
    }
    rememberGear(s.net, u.gear);
    // a cabinet worth tagging once is worth having in the library
    saveModel(u.gear);
    CUR.saved++;
    CUR.log = [...log, ...(CUR.log || [])].slice(0, 12);
    advance();
  } catch (e) {
    fail(e.message);
    btn.disabled = false;
    btn.textContent = label;
    if (open) closeChangeset(open).catch(() => {});
  } finally {
    CUR.busy = false;
  }
}

/* How recently a site opened, as a filter on either queue. AFDC stamps an open
   date on every record, and a site that opened last month is unmapped far more
   often than the average one — so "the recent ones" is a queue worth being able
   to ask for directly rather than scrolling to find. */
const OPEN_WINDOWS = [["Any age", null], ["7 days", 7], ["30 days", 30], ["90 days", 90], ["1 year", 365]];

function openedWithin(s, days) {
  if (days == null) return true;
  if (!s.open) return false;
  const d = new Date(`${String(s.open).slice(0, 10)}T00:00`);
  if (isNaN(d)) return false;
  const cut = new Date();
  cut.setHours(0, 0, 0, 0);
  cut.setDate(cut.getDate() - days);
  return d >= cut;
}

/* ------------------------------------------------------------------- queue */

/* Everything still outstanding, before the state filter — the picker needs the
   per-state counts, which are exactly this pool grouped by state. */
function candidatePool() {
  if (!MERGED) return [];
  const done = new Set(store.get(K.done, []));
  const skip = new Set(store.get(K.skip, []));
  return MERGED.sites
    /* `noted` is out as well as `osm`. This is the queue's half of what the
       dealership route already assumes: a site whose charging is recorded on
       the business hosting it has been dealt with, and offering it again asks
       for the same edit twice. Until now that only held while the localStorage
       that remembered it survived — read off the map instead, it holds on any
       machine and for whoever did the work. */
    .filter((s) => !s.osm && !s.noted && s.lat != null && s.lon != null)
    .filter((s) => !VIEW.net || s.net === VIEW.net)
    .filter((s) => !isRemembered(done, s) && !isRemembered(skip, s));
}

function candidates() {
  return candidatePool()
    .filter((s) => !VIEW.state || s.state === VIEW.state)
    .filter((s) => openedWithin(s, VIEW.impOpen))
    // newest first when a window is asked for, biggest hole otherwise
    .sort((a, b) => VIEW.impOpen != null
      ? String(b.open || "").localeCompare(String(a.open || "")) || b.ports - a.ports
      : b.ports - a.ports);
}

/* ---------------------------------------------------------------------- UI */

const ICON = {
  pencil: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>`,
  check: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5 9 17.5 20 6.5"/></svg>`,
  globe: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 3 2.6 15 0 18M12 3c-2.6 3-2.6 15 0 18"/></svg>`,
  pin: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3z"/></svg>`,
  close: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
};

const CUR = { site: null, tags: null, pin: null, layers: [], layer: null, near: [], queue: [], at: 0, busy: false, saved: 0 };
let MAP = null;
let DIRTY = false;                              // board totals need a repaint on close
let forceSetup = false;                         // editor asked for the client-id form

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// Attribution links come from a third-party index, so only ever let two schemes
// through into an href.
const safeUrl = (u) => (/^https?:\/\//i.test(String(u)) ? esc(u) : "");

function shell() {
  if ($("improve")) return $("improve");
  const root = el("div", "improve");
  root.id = "improve";
  root.hidden = true;
  root.innerHTML = `
    <div class="imp-bar">
      <div class="imp-bar-left">
        <div>
          <div class="eyebrow">Make improvements</div>
          <div class="imp-progress" id="imp-progress"></div>
        </div>
        <div class="imp-modes" id="imp-modes" role="tablist" aria-label="What to work on">
          <button class="seg-btn" data-mode="add" role="tab">Unmapped</button>
          <button class="seg-btn" data-mode="upgrade" role="tab">Mapped as a node</button>
        </div>
        <label class="imp-scope">
          <span class="ctl-label">State</span>
          <select id="imp-state" aria-label="State to work through"></select>
        </label>
        <label class="imp-scope">
          <span class="ctl-label">Opened</span>
          <select id="imp-open" aria-label="How recently the site opened">
            ${OPEN_WINDOWS.map(([label, days]) =>
              `<option value="${days ?? ""}">${label}</option>`).join("")}
          </select>
        </label>
      </div>
      <div class="imp-bar-right">
        <span class="imp-who" id="imp-who"></span>
        <button class="icon-btn" id="imp-quit" title="Close" aria-label="Close">${ICON.close}</button>
      </div>
    </div>
    <div class="imp-body">
      <div class="imp-map" id="imp-map">
        <canvas id="imp-canvas"></canvas>
        <div class="imp-imagery">
          <div class="imp-layer-row">
            <select id="imp-layer" aria-label="Imagery layer"></select>
            <button class="imp-pin" id="imp-pin" aria-pressed="false"
                    title="Keep this layer for the next sites instead of the newest one">${ICON.pin}</button>
          </div>
          <div class="imp-attr" id="imp-attr"></div>
          <div class="imp-trouble" id="imp-trouble" hidden></div>
        </div>
        <div class="zoomer imp-zoom">
          <button id="imp-zin" title="Zoom in" aria-label="Zoom in"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button>
          <button id="imp-zout" title="Zoom out" aria-label="Zoom out"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 12h14"/></svg></button>
          <button id="imp-recentre" title="Back to the reported position" aria-label="Recentre"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg></button>
        </div>
        <div class="imp-readout" id="imp-readout"></div>
      </div>
      <aside class="imp-side" id="imp-side"></aside>
    </div>`;
  document.body.append(root);

  root.querySelector("#imp-quit").onclick = close;
  root.querySelector("#imp-zin").onclick = () => MAP.zoomAround(MAP.W / 2, MAP.H / 2, 1);
  root.querySelector("#imp-zout").onclick = () => MAP.zoomAround(MAP.W / 2, MAP.H / 2, -1);
  root.querySelector("#imp-recentre").onclick = () => {
    if (CUR.site) MAP.setView(CUR.site.lat, CUR.site.lon, 19);
  };
  root.querySelector("#imp-layer").onchange = (e) => pickLayer(+e.target.value);
  root.querySelector("#imp-pin").onclick = () => {
    const on = !store.get(K.pin);
    store.set(K.pin, on);
    if (on && CUR.layer) store.set(K.layer, CUR.layer.id);
    paintPin();
    // released: back to whatever the site would have chosen on its own
    if (!on) pickLayer(Math.max(0, CUR.layers.findIndex((L) => L.id === DEFAULT_LAYER)));
  };
  root.querySelector("#imp-state").onchange = (e) => setState(e.target.value || null);
  MAP = new TileMap(root.querySelector("#imp-canvas"), root.querySelector("#imp-map"));
  for (const b of root.querySelectorAll("#imp-modes .seg-btn")) {
    b.onclick = () => {
      if (MODE() === b.dataset.mode) return;
      store.set(K.mode, b.dataset.mode);
      paintModes();
      start();
    };
  }
  const openSel = root.querySelector("#imp-open");
  openSel.value = VIEW.impOpen ?? "";
  openSel.onchange = () => {
    VIEW.impOpen = openSel.value === "" ? null : Number(openSel.value);
    start();
  };
  MAP.onpin = (ll) => { CUR.pin = ll; paintReadout(); };
  MAP.onstat = paintTrouble;
  MAP.onzoom = paintAttr;
  return root;
}

/* A layer that answers nothing but errors looks exactly like empty countryside,
   so say which it is and offer the next-ranked layer. */
function paintTrouble() {
  const node = $("imp-trouble");
  if (!node) return;
  const bad = MAP.stat.err >= 4 && MAP.stat.ok === 0;
  node.hidden = !bad;
  if (!bad) return;

  /* Move off it rather than describing the problem and waiting. A layer that
     has answered nothing but errors is not a choice the editor made, and
     staring at blank ground teaches them nothing. Done once per site, so a
     genuinely broken Esri does not start a loop. */
  const fallback = CUR.layers.findIndex((L) => L.id === DEFAULT_LAYER);
  if (!CUR.fellBack && fallback >= 0 && CUR.layers[fallback] !== CUR.layer) {
    const dead = CUR.layer?.name || "That layer";
    CUR.fellBack = true;
    pickLayer(fallback);
    node.hidden = false;
    node.innerHTML = `<b>${esc(dead)}</b> served nothing, so this is ${esc(CUR.layers[fallback].name)}.`;
    return;
  }
  const i = CUR.layers.indexOf(CUR.layer);
  const next = CUR.layers[i + 1];
  node.innerHTML =
    `<b>${esc(CUR.layer?.name || "This layer")}</b> is not serving tiles.` +
    (next ? ` <button class="imp-link" id="imp-next-layer">Use ${esc(next.name)}</button>` : "");
  node.querySelector("#imp-next-layer")?.addEventListener("click", () => pickLayer(i + 1));
}

function pickLayer(i) {
  const L = CUR.layers[i];
  if (!L) return;
  CUR.layer = L;
  store.set(K.layer, L.id);          // remembered, but only honoured while pinned
  $("imp-layer").value = String(i);
  MAP.setLayer(L);
  paintAttr();
  paintTrouble();
}

function paintPin() {
  const b = $("imp-pin");
  if (!b) return;
  const on = !!store.get(K.pin);
  b.classList.toggle("is-on", on);
  b.setAttribute("aria-pressed", String(on));
  b.title = on
    ? "Pinned: keeping this layer on the next sites. Click to follow the newest instead."
    : "Following the newest imagery for each site. Click to keep this one.";
}

function paintAttr() {
  const L = CUR.layer;
  const node = $("imp-attr");
  if (!node) return;
  const link = L && safeUrl(L.attrUrl);
  node.innerHTML = L
    ? (link ? `<a href="${link}" target="_blank" rel="noopener">${esc(L.attr || L.name)}</a>` : esc(L.attr || L.name)) +
      ` · ${esc(layerYear(L))} · z${L.max ?? 19}` +
      (MAP?.over ? `<span class="imp-over"> · ${2 ** MAP.over}× past native</span>` : "")
    : "";
}

function paintReadout() {
  const node = $("imp-readout");
  if (!node || !CUR.pin || !CUR.site) return;
  const off = metres(CUR.site, CUR.pin);
  node.innerHTML =
    `<span class="mono">${CUR.pin.lat.toFixed(6)}, ${CUR.pin.lon.toFixed(6)}</span>` +
    `<span class="imp-off${off > 150 ? " is-far" : ""}">${off < 1 ? "on the reported point" : `${Math.round(off)} m from reported`}</span>`;
}

/* The state picker doubles as the worklist: each option carries how many sites
   are still outstanding there, so it answers "where is there work" as well as
   "where do I want to be". Counts fall as you save, so it stays honest. */
function paintStates() {
  const sel = $("imp-state");
  if (!sel) return;
  const counts = new Map();
  for (const s of candidatePool()) if (s.state) counts.set(s.state, (counts.get(s.state) || 0) + 1);
  if (VIEW.state && !counts.has(VIEW.state)) counts.set(VIEW.state, 0);   // keep a cleared state selectable
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  sel.innerHTML =
    `<option value="">All states — ${nf(total)}</option>` +
    [...counts].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([st, n]) => `<option value="${st}">${st} — ${nf(n)}</option>`).join("");
  sel.value = VIEW.state || "";
}

/* Drive the board's own selector rather than setting VIEW.state here: it owns
   the rest of the bookkeeping (zoom, selection, the "All states" chip) and
   repaints, so the board is already correct when the overlay closes. */
function setState(code) {
  const board = $("state-select");
  if (board) {
    board.value = code || "";
    board.onchange?.();
  } else {
    VIEW.state = code || null;
  }
  DIRTY = false;                                // the board just repainted itself
  start();
}

function paintModes() {
  const host = $("imp-modes");
  if (!host) return;
  for (const b of host.querySelectorAll(".seg-btn")) {
    const on = b.dataset.mode === MODE();
    b.classList.toggle("is-on", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  }
}

function paintProgress() {
  const p = $("imp-progress");
  if (!p) return;
  const scope = [VIEW.net, VIEW.state].filter(Boolean).join(" · ");
  const done = CUR.saved ? ` · <span class="imp-saved">${nf(CUR.saved)} added this session</span>` : "";
  p.innerHTML = !CUR.queue.length ? ""
    : CUR.site ? `<b>${nf(CUR.at + 1)}</b> of ${nf(CUR.queue.length)} ${
        MODE() === "upgrade" ? "mapped as a node" : "unmapped"}${scope ? ` in ${esc(scope)}` : ""}${
        VIEW.impOpen != null ? `, opened in ${nf(VIEW.impOpen)} days` : ""}${done}`
    : `queue finished${done}`;
}

/* ---- sidebar ---- */

function paintSide() {
  const side = $("imp-side");
  if (!side) return;
  // forceSetup matters because the page can ship a client id: without it,
  // "use a different client id" would clear the stored one, fall straight back
  // to the built-in, and redraw the same card.
  if (forceSetup || !clientId()) return setupCard(side);
  if (!session()) return signinCard(side);
  if (!CUR.site) return emptyCard(side);
  if (MODE() === "upgrade" || CUR.up?.shape === "area") return upgradeCard(side);
  workCard(side);
}

function envPicker() {
  return `<div class="imp-env">
      ${Object.entries(ENVS).map(([k, v]) =>
        `<button class="seg-btn${envKey() === k ? " is-on" : ""}" data-env="${k}">${esc(v.label)}</button>`).join("")}
    </div>`;
}

function setupCard(side) {
  side.innerHTML = `
    <div class="imp-card">
      <h3>Connect an OSM account</h3>
      <p>Edits go to OpenStreetMap under your own account, so this needs an OAuth
         application registered there once. It takes a minute.</p>
      <ol class="imp-steps">
        <li>Open <a href="${ENV().web}/oauth2/applications/new" target="_blank" rel="noopener">${esc(ENV().web.replace("https://", ""))}/oauth2/applications/new</a>.</li>
        <li>Set the redirect URI to:<br><code class="imp-code">${esc(REDIRECT)}</code></li>
        <li>Tick <b>Read user preferences</b> and <b>Modify the map</b>. Leave "confidential application" unticked.</li>
        <li>Paste the client id here.</li>
      </ol>
      <div class="imp-env-row">${envPicker()}</div>
      <div class="imp-field">
        <input id="imp-client" placeholder="Client id" spellcheck="false" autocomplete="off"
               value="${esc(store.get(K.client(envKey())) || "")}">
        <button class="ctl-btn" id="imp-client-save">Save</button>
      </div>
      <p class="imp-note">Stored in this browser only${window.OSM_CLIENT_ID && envKey() === "osm" ? ", overriding the one this page ships with" : ""}.</p>
      ${forceSetup ? `<button class="imp-link" id="imp-client-cancel">Back</button>` : ""}
    </div>`;
  wireEnv(side);
  side.querySelector("#imp-client-cancel")?.addEventListener("click", () => { forceSetup = false; paintSide(); });
  side.querySelector("#imp-client-save").onclick = () => {
    const v = side.querySelector("#imp-client").value.trim();
    if (!v) return;
    store.set(K.client(envKey()), v);
    forceSetup = false;
    paintSide();
  };
}

function signinCard(side) {
  side.innerHTML = `
    <div class="imp-card">
      <h3>Sign in to ${esc(ENV().label)}</h3>
      <p>A window opens on OpenStreetMap and comes straight back. The board never
         sees your password — only a token you can revoke there at any time.</p>
      <div class="imp-env-row">${envPicker()}</div>
      <button class="imp-primary" id="imp-signin">Sign in with OpenStreetMap</button>
      <p class="imp-note" id="imp-waiting" hidden>Finish in the OpenStreetMap window. It will
         hand back automatically — you can close it yourself if it stays open afterwards.</p>
      <details class="imp-fold">
        <summary>Sign-in not working?</summary>
        <p class="imp-note">The application's redirect URI must be exactly this, and it changes
           with wherever the board is served from:</p>
        <code class="imp-code">${esc(REDIRECT)}</code>
      </details>
      <button class="imp-link" id="imp-cancel" hidden>Cancel sign-in</button>
      <button class="imp-link" id="imp-forget">Use a different client id</button>
      <div class="imp-error" id="imp-error" hidden></div>
    </div>`;
  wireEnv(side);
  side.querySelector("#imp-forget").onclick = () => { forceSetup = true; paintSide(); };
  side.querySelector("#imp-cancel").onclick = () => authCancel?.();
  side.querySelector("#imp-signin").onclick = async (e) => {
    const btn = e.target;
    const waiting = side.querySelector("#imp-waiting");
    const cancel = side.querySelector("#imp-cancel");
    btn.disabled = true;
    btn.textContent = "Waiting for OpenStreetMap…";
    waiting.hidden = false;
    cancel.hidden = false;
    side.querySelector("#imp-error").hidden = true;
    try {
      await signIn();
      paintWho();
      await start();
    } catch (err) {
      const box = side.querySelector("#imp-error");
      box.hidden = false;
      box.textContent = err.message;
      btn.disabled = false;
      btn.textContent = "Sign in with OpenStreetMap";
      waiting.hidden = true;
      cancel.hidden = true;
    }
  };
}

function wireEnv(side) {
  side.querySelectorAll("[data-env]").forEach((b) => {
    b.onclick = () => { store.set(K.env, b.dataset.env); paintWho(); paintSide(); };
  });
}

function emptyCard(side) {
  side.innerHTML = `
    <div class="imp-card">
      <h3>Nothing left in this view</h3>
      <p>Every unmapped site ${VIEW.state ? `in ${esc(VIEW.state)} ` : ""}${VIEW.net ? `for ${esc(VIEW.net)} ` : ""}has been
         added or skipped. Change the state or network filter on the board and reopen.</p>
      <button class="imp-link" id="imp-unskip">Bring skipped sites back</button>
    </div>`;
  side.querySelector("#imp-unskip").onclick = () => { store.del(K.skip); start(); };
}

// the chosen dealership, clamped — the list changes with every site
const carPick = () => Math.min(CUR.carPick || 0, Math.max(0, (CUR.cars?.length || 1) - 1));

/* What the dealership route would write beside charging_station=yes, or
   nothing. One definition, read by both the button's label and the write, so
   the button cannot promise a tag the write then withholds. */
/* Not gated on the source any more. `refs` is AFDC's numbering whichever feed
   the rest of the site came from — an Electrify America record reunited with
   its AFDC id has just as good a claim to write `ref:afdc` as one that arrived
   from AFDC directly, and refusing it threw away the id the reunion existed to
   recover. */
const dealerRef = (s, poi) =>
  s?.refs?.length && poi && !poi.tags["ref:afdc"] ? s.refs.join(";") : null;

const writeLabel = (d) =>
  d.pick.size ? `Add ${d.pick.size} tag${d.pick.size === 1 ? "" : "s"}` : "Nothing ticked";

/* The diff, and the one click that writes it. Rows read the same way round as
   everywhere else on this panel: the key, then what it would become. */
function diffCard(d) {
  if (d.busy) return `<div class="imp-card imp-diff"><p class="imp-note">Reading ${esc(d.type)} ${esc(d.id)}…</p></div>`;
  if (d.err) return `<div class="imp-card imp-diff"><div class="imp-warn is-hot"><b>Could not read it</b>
    <p class="imp-note">${esc(d.err)}</p></div>
    <div class="imp-actions"><button class="imp-ghost" id="imp-diff-cancel">Close</button></div></div>`;

  const n = { add: 0, upgrade: 0, change: 0, same: 0 };
  for (const r of d.rows) n[r.kind]++;
  return `
    <div class="imp-card imp-diff">
      <h3>${esc(d.label)}</h3>
      <div class="imp-net mono">${esc(d.type)} ${esc(d.id)} · v${esc(d.version)} · ${Math.round(d.away)} m away</div>
      <p class="imp-note">${n.add} to add${n.upgrade ? `, ${n.upgrade} upgrading a placeholder` : ""}${
        n.change ? `, ${n.change} that would overwrite a real value` : ""}${
        n.same ? `, ${n.same} already matching` : ""}. Only what is ticked gets written.</p>
      <div class="imp-tags">
        ${d.rows.map((r) => `
          <label class="tagrow diffrow is-${r.kind}">
            <input type="checkbox" data-diff="${esc(r.key)}"${d.pick.has(r.key) ? " checked" : ""}${
              r.kind === "same" ? " disabled" : ""}>
            <span class="tag-k mono">${esc(r.key)}</span>
            <span class="tag-v">${r.from == null ? esc(r.to)
              : `<span class="was">${esc(r.from)}</span> &rarr; ${esc(r.to)}`}</span>
            <span class="kind">${r.kind}</span>
          </label>`).join("")}
      </div>
      ${d.extras.length ? `<p class="imp-note">Left alone: ${
        d.extras.map((x) => `<span class="mono">${esc(x.key)}</span>`).join(", ")}.</p>` : ""}
      <div class="imp-actions">
        <button class="imp-primary" id="imp-diff-write">${writeLabel(d)}</button>
        <button class="imp-ghost" id="imp-diff-cancel">Cancel</button>
      </div>
    </div>`;
}

function workCard(side) {
  const s = CUR.site;
  side.innerHTML = `
    <div class="imp-card imp-card--site">
      <h3>${esc(s.name || "Unnamed site")}</h3>
      <div class="imp-net">${brandMark(s.net)}${esc(s.net)}</div>
      <dl class="imp-facts">
        <dt>Ports</dt><dd>${nf(s.ports)}</dd>
        <dt>Reported</dt><dd class="mono">${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}</dd>
        <dt>Source</dt><dd>${esc(s.src)}</dd>
        ${s.open ? `<dt>Opened</dt><dd>${esc(s.open)}</dd>` : ""}
      </dl>
    </div>

    ${CUR.near.length ? `
      <div class="imp-warn is-hot">
        <b>Already on the map</b>
        <p class="imp-note">Within 250 m of the pin, measured to the edge of whatever is
           mapped — <span class="mono">0 m</span> means the pin is standing inside it.</p>
        ${CUR.near.slice(0, 4).map((n, i) =>
          `<div class="imp-near">
             <a href="${ENV().web}/${n.type}/${n.id}" target="_blank" rel="noopener">${esc(n.tags.name || n.tags.operator || n.tags.brand || `${n.type} ${n.id}`)}</a>
             <span class="mono">${Math.round(n.away)} m${n.kind === "point" ? " · charge point" : ""}</span>
             <button class="imp-link" data-near="${i}"${CUR.diff && CUR.diff.id === n.id ? " disabled" : ""}>Add missing information</button>
           </div>`).join("")}
        ${CUR.near.some((n) => n.kind === "point") && !CUR.near.some((n) => n.kind === "station") ? `
          <p class="imp-note">Only individual charge points are mapped here, with no station
             around them. Adding what is known to one of them is fine; grouping them into a
             station is what the charge points tool is for.</p>` : ""}
        <button class="imp-link" id="imp-mapped">Mark as already mapped and skip</button>
      </div>` : ""}

    ${CUR.diff ? diffCard(CUR.diff) : ""}

    ${CUR.cars?.length ? `
      <div class="imp-poi">
        <b>${CUR.cars[0].away === 0 ? "The pin is inside a car dealership" : "Car dealership next to the pin"}</b>
        ${CUR.cars.slice(0, 5).map((c, i) => `
          <div class="imp-poi-row${i === carPick() ? " is-on" : ""}">
            <button class="imp-poi-pick" data-car="${i}" aria-pressed="${i === carPick()}">
              ${esc(c.tags.name || c.tags.brand || `${c.type} ${c.id}`)}
            </button>
            <span class="mono">${esc(c.tags.shop ? `shop=${c.tags.shop}` : c.tags.amenity ? `amenity=${c.tags.amenity}` : "car brand")} · ${Math.round(c.away)} m</span>
            <a href="${ENV().web}/${c.type}/${c.id}" target="_blank" rel="noopener" title="Open on OpenStreetMap" aria-label="Open on OpenStreetMap">&#8599;</a>
          </div>`).join("")}
        <p class="imp-note">${CUR.cars.length > 1 ? "Pick the one the charger belongs to. " : ""}Dealership
           chargers are usually for customers or staff, and often not visible from above.
           Say which rather than implying it is open to all.</p>
        <div class="imp-poi-acts">
          <button class="imp-chip" data-access="customers">access=customers</button>
          <button class="imp-chip" data-access="private">access=private</button>
          <button class="imp-chip" data-access="yes">access=yes</button>
          <button class="imp-chip" data-put="charging_station">charging_station=yes</button>
        </div>
        <button class="imp-ghost imp-poi-alt" id="imp-tag-dealer">
          Instead: tag ${esc(CUR.cars[carPick()].tags.name || "the dealership")} charging_station=yes${
            dealerRef(s, CUR.cars[carPick()]) ? " and ref:afdc" : ""}
        </button>
      </div>` : ""}

    ${shapeSwitch(CUR.up || { shape: "node" })}

    <div class="imp-tags-head">
      <span class="imp-h">Tags</span>
      <button class="imp-link" id="imp-add">Add tag</button>
    </div>
    <div class="imp-tags" id="imp-tags"></div>
    <div class="imp-wd" id="imp-wd" hidden></div>

    <label class="imp-check">
      <input type="checkbox" id="imp-fixme"${CUR.tags.fixme === FIXME_APPROX ? " checked" : ""}>
      <span>Location is approximate
        <em>Adds <span class="mono">fixme</span> so somebody passing can pin it properly.</em></span>
    </label>
    ${(s.refs?.length || 0) > 1 ? `<p class="imp-note"><span class="mono">ref:afdc</span> lists all
       ${nf(s.refs.length)} AFDC records this site was collapsed from — they share an address or
       stand within 80 m of each other. Trim it if the imagery shows two separate sites.</p>` : ""}

    <p class="imp-note">Look before you save: if the imagery shows nothing there, skip it.
       These are surveyed one-off edits, not an import.</p>
    <div class="imp-keys"><kbd>Enter</kbd> save · <kbd>S</kbd> skip · <kbd>Esc</kbd> close</div>
    ${CUR.log?.length ? `<div class="imp-h">Added this session</div>
      <div class="imp-log">${CUR.log.map((r) =>
        `<div><a href="${ENV().web}/${r.type || "node"}/${r.id}" target="_blank" rel="noopener">${esc(r.name)}</a>
          <span class="mono">#${r.cs}</span></div>`).join("")}</div>` : ""}

    <div class="imp-error" id="imp-error" hidden></div>
    <div class="imp-actions">
      <button class="imp-primary" id="imp-save">Save &amp; next</button>
      <button class="imp-ghost" id="imp-skip">Skip</button>
    </div>`;

  paintTags();
  bindShapeSwitch(side);
  const fx = side.querySelector("#imp-fixme");
  if (fx) {
    fx.onchange = () => {
      /* Only ever touches the value this box owns. A `fixme` the mapper typed
         themselves, or one carried over from the element, is not ours to clear —
         unticking removes the approximate-location note and nothing else. */
      if (fx.checked) CUR.tags.fixme = FIXME_APPROX;
      else if (CUR.tags.fixme === FIXME_APPROX) delete CUR.tags.fixme;
      paintTags();
    };
  }
  side.querySelector("#imp-save").onclick = save;
  side.querySelector("#imp-skip").onclick = () => skip("skip");
  side.querySelector("#imp-add").onclick = () => addTag();
  side.querySelector("#imp-mapped")?.addEventListener("click", () => skip("done"));
  side.querySelectorAll("[data-near]").forEach((b) => {
    b.onclick = () => readNear(Number(b.dataset.near));
  });
  side.querySelector("#imp-diff-write")?.addEventListener("click", writeNear);
  side.querySelector("#imp-diff-cancel")?.addEventListener("click", () => { CUR.diff = null; paintSide(); });
  side.querySelectorAll("[data-diff]").forEach((b) => {
    b.onchange = () => {
      if (b.checked) CUR.diff.pick.add(b.dataset.diff);
      else CUR.diff.pick.delete(b.dataset.diff);
      // Only the button's count changes; repainting would lose the scroll position.
      const w = side.querySelector("#imp-diff-write");
      if (w) w.textContent = writeLabel(CUR.diff);
    };
  });
  side.querySelectorAll("[data-access]").forEach((b) => {
    b.onclick = () => {
      CUR.tags = withAfter(CUR.tags, "amenity", "access", b.dataset.access);
      paintTags();
      paintSide();
    };
  });
  side.querySelectorAll("[data-put]").forEach((b) => {
    b.onclick = () => {
      CUR.tags = withAfter(CUR.tags, "amenity", b.dataset.put, "yes");
      paintTags();
      paintSide();
    };
  });
  side.querySelectorAll("[data-car]").forEach((b) => {
    b.onclick = () => { CUR.carPick = +b.dataset.car; paintSide(); };
  });
  side.querySelector("#imp-tag-dealer")?.addEventListener("click", tagDealership);
}

/* ---- tag rows ---- */

function paintTags() {
  const host = $("imp-tags");
  if (!host) return;
  host.innerHTML = "";
  for (const [k, v] of Object.entries(CUR.tags)) {
    const row = el("div", "tagrow");
    // The globe is the only icon here that adds something rather than fixing
    // it, so it stands out while the QID is missing and goes quiet once set.
    const missing = WD_KEYS.has(k) && !CUR.tags[`${k}:wikidata`];
    const wd = WD_KEYS.has(k)
      ? `<button class="tag-btn${missing ? " is-suggest" : ""}" data-act="wd"
           title="${missing ? `Add ${esc(k)}:wikidata` : `Change ${esc(k)}:wikidata`}"
           aria-label="Look up ${esc(k)} on Wikidata">${ICON.globe}</button>`
      : "";
    row.innerHTML =
      `<div class="tag-k mono">${esc(k)}</div>` +
      `<div class="tag-v">${esc(v)}</div>` +
      `<div class="tag-act">${wd}` +
        `<button class="tag-btn" data-act="edit" title="Edit ${esc(k)}" aria-label="Edit ${esc(k)}">${ICON.pencil}</button>` +
        `<button class="tag-btn" data-act="del" title="Delete ${esc(k)}" aria-label="Delete ${esc(k)}">${ICON.trash}</button>` +
      `</div>`;
    row.querySelector('[data-act="edit"]').onclick = () => editRow(row, k);
    row.querySelector('[data-act="del"]').onclick = () => { delete CUR.tags[k]; paintTags(); };
    row.querySelector('[data-act="wd"]')?.addEventListener("click", () => openWikidata(k));
    host.append(row);
  }
  paintWikidata();
  if (!Object.keys(CUR.tags).length) host.append(el("div", "imp-note", "No tags left — add at least one before saving."));
}

/* ---- Wikidata lookup ------------------------------------------------------
   Anonymous CORS search against wikidata.org. Results are shown with their
   description because that is what tells "Blink Charging" from "Blink (band)",
   and nothing is written until one is clicked. */

const WD = { key: null, query: "", results: [], busy: false, error: null };

async function openWikidata(key) {
  WD.key = key;
  WD.query = CUR.tags[key] || "";
  WD.results = [];
  WD.error = null;
  paintWikidata();
  $("imp-wd")?.scrollIntoView({ block: "nearest" });
  if (WD.query) await searchWikidata();
  else $("wd-q")?.focus();
}

/* The lookup itself, with no UI attached, so the charge-point site can offer the
   same search against the same remembered answers. */
async function wikidataSearch(q) {
  const url = "https://www.wikidata.org/w/api.php?" + new URLSearchParams({
    action: "wbsearchentities", format: "json", origin: "*",
    language: "en", uselang: "en", type: "item", limit: "8", search: q,
  });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Wikidata returned HTTP ${res.status}`);
  const body = await res.json();
  return (body.search || []).map((r) => ({ id: r.id, label: r.label || r.id, description: r.description || "" }));
}

async function searchWikidata() {
  const q = WD.query.trim();
  if (!q) return;
  WD.busy = true;
  WD.error = null;
  paintWikidata();
  try {
    WD.results = await wikidataSearch(q);
  } catch (e) {
    WD.error = e.message;
    WD.results = [];
  }
  WD.busy = false;
  paintWikidata();
}

function paintWikidata() {
  const host = $("imp-wd");
  if (!host) return;
  host.hidden = !WD.key;
  if (!WD.key) { host.innerHTML = ""; return; }   // leave nothing behind to reappear
  const current = CUR.tags[`${WD.key}:wikidata`];
  host.innerHTML =
    `<div class="imp-tags-head">
       <span class="imp-h">Wikidata for ${esc(WD.key)}</span>
       <button class="imp-link" id="wd-close">Close</button>
     </div>
     <div class="imp-field">
       <input id="wd-q" value="${esc(WD.query)}" placeholder="Search Wikidata" spellcheck="false" autocomplete="off">
       <button class="ctl-btn" id="wd-go">Search</button>
     </div>` +
    `<p class="imp-note">Picking an entry sets <span class="mono">${esc(WD.key)}:wikidata</span> and rewrites
       <span class="mono">${esc(WD.key)}</span> to that entity's label, so the two agree.
       ${current ? `Currently <span class="mono">${esc(current)}</span>.` : ""}</p>` +
    (WD.busy ? `<p class="imp-note">Searching…</p>` : "") +
    (WD.error ? `<div class="imp-error">${esc(WD.error)}</div>` : "") +
    (!WD.busy && !WD.error && !WD.results.length && WD.query ? `<p class="imp-note">Nothing found. Try the company's full legal name.</p>` : "") +
    `<div class="wd-list">${WD.results.map((r) =>
       `<button class="wd-row${r.id === current ? " is-on" : ""}" data-id="${esc(r.id)}">
          <b>${esc(r.label)}</b>
          <span class="wd-desc">${esc(r.description) || "no description"}</span>
          <span class="mono">${esc(r.id)}</span>
        </button>`).join("")}</div>` +
    (current ? `<button class="imp-link" id="wd-forget">Remove ${esc(WD.key)}:wikidata</button>` : "");

  host.querySelector("#wd-close").onclick = () => { WD.key = null; paintWikidata(); };
  host.querySelector("#wd-go").onclick = () => { WD.query = host.querySelector("#wd-q").value; searchWikidata(); };
  host.querySelector("#wd-q").onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); WD.query = e.target.value; searchWikidata(); }
    if (e.key === "Escape") { e.preventDefault(); WD.key = null; paintWikidata(); }
  };
  host.querySelector("#wd-forget")?.addEventListener("click", () => {
    // forget it for good, or the next site of this network brings it back
    forgetWikidata(CUR.raw?.[WD.key] || CUR.tags[WD.key]);
    delete CUR.tags[`${WD.key}:wikidata`];
    paintTags();
  });
  host.querySelectorAll(".wd-row").forEach((b) => {
    b.onclick = () => {
      const key = WD.key;
      const was = CUR.tags[key];
      const picked = WD.results.find((r) => r.id === b.dataset.id);
      // The tag takes the entity's own spelling: a QID that disagrees with the
      // name beside it is two claims where there should be one.
      if (picked?.label) CUR.tags[key] = picked.label;
      CUR.tags = withAfter(CUR.tags, key, `${key}:wikidata`, b.dataset.id);
      if (was) syncMemory(key);
      WD.key = null;
      paintTags();
    };
  });
}

/* Set `insert` immediately after `anchor`, so brand:wikidata sits under brand
   instead of at the end of the list. */
function withAfter(tags, anchor, insert, value) {
  const out = {};
  for (const [k, v] of Object.entries(tags)) {
    if (k === insert) continue;
    out[k] = v;
    if (k === anchor) out[insert] = value;
  }
  if (!(insert in out)) out[insert] = value;
  return out;
}

/* Every proposed tag is meant to be OSM-ready, so editing is the exception, not
   the flow. It opens in place, keeps the row's position, and takes Enter and
   Escape the way any inline edit should. */
function editRow(row, key) {
  const val = CUR.tags[key];
  row.classList.add("is-editing");
  row.innerHTML =
    `<input class="tag-in mono" value="${esc(key)}" spellcheck="false" aria-label="Tag key">` +
    `<input class="tag-in" value="${esc(val)}" spellcheck="false" aria-label="Tag value">` +
    `<div class="tag-act">` +
      `<button class="tag-btn is-ok" data-act="ok" title="Apply" aria-label="Apply">${ICON.check}</button>` +
      `<button class="tag-btn" data-act="cancel" title="Cancel" aria-label="Cancel">${ICON.close}</button>` +
    `</div>`;
  const [kIn, vIn] = row.querySelectorAll(".tag-in");
  const apply = () => {
    const nk = kIn.value.trim(), nv = vIn.value.trim();
    if (!nk || !nv || nk.length > 255 || nv.length > 255) { paintTags(); return; }
    // rebuild in order so an edited key keeps its place in the list
    CUR.tags = Object.fromEntries(
      Object.entries(CUR.tags).map(([k, v]) => (k === key ? [nk, nv] : [k, v])));
    syncMemory(nk);
    paintTags();
  };
  row.querySelector('[data-act="ok"]').onclick = apply;
  row.querySelector('[data-act="cancel"]').onclick = () => paintTags();
  for (const input of [kIn, vIn]) {
    input.onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); apply(); }
      if (e.key === "Escape") { e.preventDefault(); paintTags(); }
    };
  }
  vIn.focus();
  vIn.select();
}

function addTag() {
  const host = $("imp-tags");
  if (!host) return;
  const row = el("div", "tagrow is-editing");
  row.innerHTML =
    `<input class="tag-in mono" placeholder="key" spellcheck="false" aria-label="Tag key">` +
    `<input class="tag-in" placeholder="value" spellcheck="false" aria-label="Tag value">` +
    `<div class="tag-act">` +
      `<button class="tag-btn is-ok" data-act="ok" title="Add" aria-label="Add">${ICON.check}</button>` +
      `<button class="tag-btn" data-act="cancel" title="Cancel" aria-label="Cancel">${ICON.close}</button>` +
    `</div>`;
  host.append(row);
  const [kIn, vIn] = row.querySelectorAll(".tag-in");
  const apply = () => {
    const k = kIn.value.trim(), v = vIn.value.trim();
    if (k && v && k.length <= 255 && v.length <= 255) { CUR.tags[k] = v; syncMemory(k); }
    paintTags();
  };
  row.querySelector('[data-act="ok"]').onclick = apply;
  row.querySelector('[data-act="cancel"]').onclick = () => paintTags();
  for (const input of [kIn, vIn]) {
    input.onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); apply(); }
      if (e.key === "Escape") { e.preventDefault(); paintTags(); }
    };
  }
  kIn.focus();
}

function paintWho() {
  const who = $("imp-who");
  if (!who) return;
  const s = session();
  who.innerHTML = s
    ? `<span class="mono">${esc(s.user)}</span>${envKey() === "dev" ? ` <span class="chip" style="color:var(--s4)">sandbox</span>` : ""}
       <button class="imp-link" id="imp-out">sign out</button>`
    : "";
  who.querySelector("#imp-out")?.addEventListener("click", signOut);
}

/* ------------------------------------------------------------------- flow */

const MODE = () => (store.get(K.mode) === "upgrade" ? "upgrade" : "add");

async function start() {
  CUR.queue = MODE() === "upgrade" ? upgrades() : candidates();
  CUR.at = 0;
  paintModes();
  CUR.log = CUR.log || [];
  await loadImagery();
  await show();
}

async function show() {
  const s = CUR.queue[CUR.at] || null;
  CUR.site = s;
  CUR.near = [];
  CUR.cars = [];
  CUR.carPick = 0;
  CUR.diff = null;
  WD.key = null;
  paintProgress();
  paintStates();
  if (!s) { paintSide(); return; }

  /* Both modes get the same tools. The only difference is what is already
     there: an upgrade has a node to deal with at the end, a new site does not,
     and a new site may still be answered with a plain node if that is all the
     imagery supports. One editor, two starting conditions. */
  if (MODE() === "upgrade" || CUR.up?.shape === "area") {
    CUR.up = { tool: null, ring: [], pts: [], square: true, keep: "point",
               shape: "area",
               cfg: defaultCfg(CUR.site?.units), gear: gearFor(CUR.site?.net) };
    MAP.onmapclick = upgradeClick;
    MAP.drawOthers = drawUpgrade;
    /* Only charge points, and only nodes. A station mapped as an area cannot be
       dragged by one corner without deforming it, and a station node is the
       thing being replaced — moving it would be work about to be thrown away. */
    MAP.grab = (p) => {
      for (const o of MAP.others || []) {
        if (o.kind !== "point" || o.type !== "node") continue;
        const [x, y] = MAP.toPx(o.lat, o.lon);
        if (Math.hypot(p.x - x, p.y - y) < 14) return o;
      }
      return null;
    };
    MAP.ongrab = (o, ll) => {
      o.lat = ll.lat;
      o.lon = ll.lon;
      o.moved = metres(o.home, o) >= 0.5;
      MAP.schedule();
      clearTimeout(CUR.movedPaint);
      CUR.movedPaint = setTimeout(paintSide, 120);   // redraw the row once, not per frame
    };
  } else {
    CUR.up = { shape: "node" };
    MAP.onmapclick = null;
    MAP.drawOthers = null;
    MAP.grab = null;
    MAP.ongrab = null;
  }
  CUR.tags = proposeTags(s);
  CUR.raw = networkFor(s);        // names as proposed, before any relabelling
  CUR.pin = { lat: s.lat, lon: s.lon };
  CUR.layers = rankLayers(s.lon, s.lat);
  if (!CUR.layers.length) CUR.layers = FALLBACK_LAYERS;
  /* Esri World Imagery by default: it covers everywhere, it is sharp, and it
     answers — where the date-ranked pick is often a county or federal server
     that is slow, offline, or in NAIP's case refusing connections outright, and
     blank ground is worse than undated ground. The list is still ranked newest
     first, so the freshest local survey is one click away, and pinning keeps
     whatever you choose.

     The ranking itself has not changed; only which entry starts selected. */
  const pinned = store.get(K.pin) ? CUR.layers.find((L) => L.id === store.get(K.layer)) : null;
  CUR.layer = pinned || CUR.layers.find((L) => L.id === DEFAULT_LAYER) || CUR.layers[0];
  CUR.fellBack = false;

  const sel = $("imp-layer");
  sel.innerHTML = CUR.layers.map((L, i) =>
    `<option value="${i}">${esc(L.name)} — ${esc(layerYear(L))}${L.max >= 20 ? ` · z${L.max}` : ""}</option>`).join("");
  sel.value = String(CUR.layers.indexOf(CUR.layer));

  MAP.ghost = MODE() === "upgrade" ? null : { lat: s.lat, lon: s.lon };
  MAP.pin = MODE() === "upgrade" ? null : CUR.pin;
  MAP.others = [];
  MAP.setLayer(CUR.layer);
  MAP.setView(s.lat, s.lon, 19);
  paintAttr();
  paintPin();
  paintTrouble();
  paintReadout();
  paintSide();

  // Non-blocking: the editor can start placing while this comes back.
  const forSite = s;
  nearbyStations(s.lat, s.lon).then(({ stations, cars }) => {
    if (CUR.site !== forSite) return;
    // Where each one started, so a nudge can be measured against it and put back
    for (const o of stations) o.home = { lat: o.lat, lon: o.lon };
    CUR.near = stations;
    CUR.cars = cars;
    MAP.others = stations;
    MAP.schedule();
    /* Repainting the sidebar would throw away a half-typed tag edit — and, in
       the upgrade card, take the caret out of the manufacturer field mid-word.
       The map still updates either way; only the panel waits. */
    const typing = $("imp-tags")?.querySelector(".is-editing")
      || $("imp-side")?.contains(document.activeElement) && document.activeElement?.tagName === "INPUT";
    if (!typing) paintSide();
  }).catch(() => { /* read-only nicety; never block an edit on it */ });
}

function fail(msg) {
  const box = $("imp-error");
  if (!box) { console.error(`[improve] ${msg}`); return; }
  box.hidden = false;
  box.textContent = msg;
}

function advance() {
  CUR.at++;
  show();
}

function skip(kind) {
  const s = CUR.site;
  if (!s) return;
  // each mode remembers separately: a site dealt with as unmapped has not been
  // dealt with as a node that wants an outline, and vice versa
  if (MODE() === "upgrade") remember(kind === "done" ? K.upDone : K.upSkip, s);
  else if (kind === "done") { remember(K.done, s); s.osm = true; DIRTY = true; }
  else remember(K.skip, s);
  advance();
}

/* ------------------------------------------------- improving what is there

   The third answer to "already on the map", beside adding a node and skipping.
   A site can be mapped and still be missing most of what this board knows about
   it — a bare `amenity=charging_station` with no operator, no socket count, no
   network — and until now the only thing to do about that was skip, which threw
   the knowledge away and left the site to come back around next time.

   The diff is the same one the dealers page has used all along, which is why
   `planTags` now lives in this file: adds and upgrades arrive ticked, a change
   that would overwrite something real never does, and what OSM has that we do
   not is listed where it is obvious that uploading leaves it alone. */
async function readNear(i) {
  const n = CUR.near[i];
  if (!n || CUR.busy) return;
  const forSite = CUR.site;
  CUR.diff = { type: n.type, id: n.id, kind: n.kind, away: n.away,
               label: n.tags.name || n.tags.operator || n.tags.brand || `${n.type} ${n.id}`,
               busy: true, rows: null, err: null };
  paintSide();
  try {
    const el = await fetchElement(n.type, n.id);
    if (CUR.site !== forSite) return;                  // moved on while it read
    /* What the board knows, minus what would misdescribe the thing being
       written to. On a charge point `amenity` is absent, so it would come up as
       an add and arrive ticked — and adding amenity=charging_station to a stall
       says the stall is the whole site. Everything else about the site is still
       true of the stall, so only that one key goes. */
    const proposed = { ...CUR.tags };
    if (n.kind === "point") delete proposed.amenity;
    const rows = planTags(el.tags, proposed);
    CUR.diff = { ...CUR.diff, busy: false, version: el.version, rows,
                 extras: extraTags(el.tags, proposed),
                 pick: new Set(rows.filter((r) => safeKinds.has(r.kind)).map((r) => r.key)) };
  } catch (e) {
    if (CUR.site !== forSite) return;
    CUR.diff = { ...CUR.diff, busy: false, err: e.message };
  }
  paintSide();
}

async function writeNear() {
  const d = CUR.diff, s = CUR.site;
  if (!d?.rows || CUR.busy || !s) return;
  const tags = {};
  for (const r of d.rows) if (d.pick.has(r.key)) tags[r.key] = r.to;
  if (!Object.keys(tags).length) return fail("Nothing ticked — pick a tag, or skip the site.");

  CUR.busy = true;
  const btn = $("imp-diff-write");
  const label = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "Opening changeset…"; }
  let open = null;
  try {
    const cs = (open = await createChangeset({
      created_by: `${APP} ${VERSION}`,
      comment: `Add detail to charging station${tags.brand ? ` (${tags.brand})` : ""}${s.state ? ` in ${s.state}` : ""}`,
      source: "operator data",
      "charge_board:lead": s.src,
    }));
    if (btn) btn.textContent = "Uploading…";
    // The version the human actually reviewed. If it moved while they read, the
    // write is refused rather than landing on top of somebody else's edit.
    const { written } = await applyTags(d.type, d.id, tags, cs, d.version);
    await closeChangeset(cs);
    open = null;

    remember(K.done, s);
    /* It was already mapped — that is what the diff was against. Marking it
       here only spares the board waiting for the next snapshot to agree. */
    s.osm = true;
    if (Object.keys(tags).some((k) => k.startsWith("socket:"))) s.osmDetail = true;
    DIRTY = true;
    CUR.saved++;
    CUR.log = [{ id: d.id, type: d.type, cs,
                 name: `${d.label} +${written.length} tag${written.length === 1 ? "" : "s"}` },
               ...(CUR.log || [])].slice(0, 12);
    CUR.diff = null;
    advance();
  } catch (e) {
    fail(e.message);
    if (btn) { btn.disabled = false; btn.textContent = label; }
    // A stale version is not a dead end: re-read and the diff comes back
    // against what is there now, with the same rows ticked as before.
    if (e.stale) readNear(CUR.near.findIndex((n) => n.type === d.type && n.id === d.id));
    if (open) closeChangeset(open).catch(() => {});
  } finally {
    CUR.busy = false;
  }
}

/* The dealership route: record the charging on the business that owns it and
   add no node at all. For a forecourt you cannot see from above and cannot
   separate from the lot, this says what is known and nothing more.

   Whether that counts as mapped depends on what goes with it. The tag alone is
   only a mention, and the board reads it as such. Written beside a `ref:afdc`
   naming this exact record it is a positive claim that the record is accounted
   for, and the board counts it — so when this route writes the id, it says so
   here too rather than waiting for the next snapshot to agree. */
async function tagDealership() {
  const poi = CUR.cars?.[carPick()];
  const s = CUR.site;
  if (!poi || !s || CUR.busy) return;
  const btn = $("imp-tag-dealer");
  const label = btn.textContent;
  CUR.busy = true;
  btn.disabled = true;
  btn.textContent = "Tagging…";
  let open = null;
  try {
    const cs = (open = await createChangeset({
      created_by: `${APP} ${VERSION}`,
      comment: `Note charging at ${poi.tags.name || "car dealership"}${s.state ? ` in ${s.state}` : ""}`,
      source: CUR.layer ? CUR.layer.name : "aerial imagery",
      imagery_used: CUR.layer ? CUR.layer.name : "aerial imagery",
      "charge_board:lead": s.src,
    }));
    /* The AFDC id rides along. It belongs here as much as on a station node:
       what it names is the record this edit answers, and a shop that has
       swallowed a charging station is that record's site. 306 of the ~2,400 US
       elements carrying `ref:afdc` are shop=car, and every one of them carries
       `charging_station=yes` beside it — this pairing is what other mappers
       already do, not something being started here.

       Never over an id the element already has: that one was put there by
       someone who looked, and a dealership 250 m from the reported coordinate
       is not grounds to overrule them. */
    const ref = dealerRef(s, poi);
    const { written } = await applyTags(
      poi.type, poi.id, { charging_station: "yes", ...(ref ? { "ref:afdc": ref } : {}) }, cs);
    await closeChangeset(cs);
    open = null;
    remember(K.done, s);
    // Only where the id went on — see above. A bare charging_station=yes leaves
    // the site noted, which is not the same as mapped and must not be shown as it.
    if (ref || poi.tags["ref:afdc"]) { s.osm = true; s.hostOnly = true; s.noted = false; DIRTY = true; }
    CUR.saved++;
    CUR.log = [{ id: poi.id, cs, type: poi.type, name: `${poi.tags.name || poi.type} ${written.length ? written.join(", ") : "(already tagged)"}` },
               ...(CUR.log || [])].slice(0, 12);
    advance();
  } catch (e) {
    fail(e.message);
    btn.disabled = false;
    btn.textContent = label;
    if (open) closeChangeset(open).catch(() => {});
  } finally {
    CUR.busy = false;
  }
}

async function save() {
  if (CUR.busy || !CUR.site) return;
  const s = CUR.site, tags = { ...CUR.tags }, pin = { ...CUR.pin };
  if (!Object.keys(tags).length) return fail("Add at least one tag before saving.");
  if (!tags.amenity) return fail("Nothing here says what this is — an amenity tag is required.");

  CUR.busy = true;
  const btn = $("imp-save");
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Opening changeset…";
  let open = null;
  try {
    const cs = (open = await createChangeset({
      created_by: `${APP} ${VERSION}`,
      comment: `Add charging station${tags.brand ? ` (${tags.brand})` : ""}${s.state ? ` in ${s.state}` : ""}`,
      source: CUR.layer ? CUR.layer.name : "aerial imagery",
      imagery_used: CUR.layer ? CUR.layer.name : "aerial imagery",
      // Where the lead came from, so a reviewer can judge it without asking.
      "charge_board:lead": s.src,
    }));
    btn.textContent = "Uploading…";
    const id = await uploadNode(cs, pin.lat, pin.lon, tags);
    await closeChangeset(cs);
    open = null;

    remember(K.done, s);
    s.osm = true;
    s.osmId = `n${id}`;
    s.osmExt = 0;
    s.osmDetail = Object.keys(tags).some((k) => k.startsWith("socket:"));
    DIRTY = true;
    CUR.saved++;
    CUR.log = [{ id, cs, name: tags.brand || s.net }, ...(CUR.log || [])].slice(0, 12);
    advance();
  } catch (e) {
    fail(e.message);
    btn.disabled = false;
    btn.textContent = label;
    // Do not leave a changeset open behind a failed upload; the next attempt
    // opens its own, and an abandoned one sits there for an hour otherwise.
    if (open) closeChangeset(open).catch(() => {});
  } finally {
    CUR.busy = false;
  }
}

/* -------------------------------------------------------------- open/close */

/* Open the panel on one particular site, from a click on the board rather than
   by working down a queue. The queue is still built — skipping from here should
   carry on with its neighbours rather than dead-end — but it starts on the site
   asked for, and the mode is chosen to match what that site needs. */
async function openAt(site) {
  if (!site) return open();
  store.set(K.mode, site.osm ? "upgrade" : "add");
  // an unmapped site of any age must not be filtered out from under the click
  VIEW.impOpen = null;
  await open();
  if (!CUR.queue.length) return;
  const at = CUR.queue.findIndex((q) => q === site
    || (q.lat === site.lat && q.lon === site.lon && q.net === site.net));
  if (at >= 0) { CUR.at = at; show(); }
  else {
    // remembered as done, or outside the mode's pool — show it anyway
    CUR.queue = [site, ...CUR.queue];
    CUR.at = 0;
    show();
  }
}

async function open() {
  const root = shell();
  root.hidden = false;
  document.body.classList.add("is-improving");
  paintWho();
  paintSide();
  MAP.schedule();
  addEventListener("keydown", keys);
  if (!MERGED) { $("imp-side").innerHTML = `<div class="imp-card"><h3>Still loading</h3><p>The board is fetching its data. Try again in a moment.</p></div>`; return; }
  if (session() && clientId()) await start();
}

function close() {
  const root = $("improve");
  if (root) root.hidden = true;
  document.body.classList.remove("is-improving");
  removeEventListener("keydown", keys);
  if (DIRTY && MERGED) { DIRTY = false; render(MERGED); }
}

function keys(e) {
  if ($("improve")?.hidden) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
  if (e.key === "Escape" && !typing) { e.preventDefault(); close(); return; }
  if (typing || !CUR.site) return;
  if (e.key === "Enter") { e.preventDefault(); save(); }
  else if (e.key === "s" || e.key === "S") { e.preventDefault(); skip("skip"); }
  else if (MODE() === "upgrade" && (e.key === "q" || e.key === "Q")) {
    e.preventDefault();
    if (CUR.up) { CUR.up.square = !CUR.up.square; paintSide(); MAP.schedule(); }
  }
  else if (MODE() === "upgrade" && (e.key === "z" || e.key === "Z")) { e.preventDefault(); undoUpgrade(); }
  else if (e.key === "+" || e.key === "=") { MAP.zoomAround(MAP.W / 2, MAP.H / 2, 1); }
  else if (e.key === "-") { MAP.zoomAround(MAP.W / 2, MAP.H / 2, -1); }
}

/* Shared with the charge-point site, which needs the same sign-in, the same
   tile map and the same imagery ranking. Exposed rather than copied: one
   implementation of the OAuth dance and one of the changeset upload is all
   anyone should have to reason about. */
window.OSMKit = {
  ENVS, envKey, ENV, clientId, session, signIn, signOut,
  osmFetch, createChangeset, uploadNode, closeChangeset,
  fetchElement, applyTags, replaceTags, moveNodes, planTags, extraTags, safeKinds, isUpgrade,
  createWay, dedupe, squareUp, rectangleFrom3, shapeFor, worstCorner, metresBetween,
  TileMap, loadImagery, rankLayers, layerYear, FALLBACK_LAYERS,
  tagXml, cleanTags, esc, xesc, withAfter, ringDistance, inRing,
  store, K, REDIRECT, ICON, APP, VERSION, tokenHint, DEFAULT_LAYER,
  // the Wikidata lookup and, importantly, the answers already confirmed on this
  // board — a brand named once is named everywhere
  wikidataSearch, recallWikidata, rememberWikidata, forgetWikidata,
};

const btn = $("improve-open");
if (btn) btn.addEventListener("click", () => open().catch((e) => fail(e.message)));
// the board's own lists open the panel through here
window.ImproveAt = (site) => openAt(site).catch((e) => fail(e.message));
})();
