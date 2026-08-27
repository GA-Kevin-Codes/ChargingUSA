/* The worker asks Overpass for every US charging station in one query, which is
   fine against a keyed endpoint and far too heavy for a public one — it comes
   back 504. Same data, asked state by state: each query is small, the instance
   stays happy, and the results are identical once merged and de-duplicated by
   element id. Slimming is worker.js's own slimOsm, so the file matches what the
   deployed worker would serve. */
import { readFileSync, writeFileSync, renameSync, statSync } from "fs";

/* Progress goes to a file, not stdout: bun buffers a piped stdout in large
   chunks, so a reader watching the pipe sees nothing for minutes and then
   everything at once. A file is read whenever someone asks. */
const PROGRESS = new URL("./progress.json", import.meta.url).pathname;
const JOB_TOKEN = process.env.CB_JOB || "";   // stamped so a stray run's notes are ignored
const report = (note) => { try { writeFileSync(PROGRESS, JSON.stringify({ note, job: JOB_TOKEN, at: Date.now() })); } catch {} };

const OUT = new URL("../data/osm.json", import.meta.url).pathname;
const src = readFileSync(new URL("./worker.js", import.meta.url).pathname, "utf8")
  .replace(/export default\s*\{/, "const _routes = {")
  .replace(/export\s*\{[^}]*\};?/g, "");
(0, eval)(src + "\n;Object.assign(globalThis,{ slimOsm, splitOsm });");

const STATE_DATA = JSON.parse(readFileSync(new URL("../data/states.json", import.meta.url).pathname, "utf8"));
/* --state=FL refreshes one state and merges it into the existing snapshot.
   A full sweep is 51 queries against a public instance that is often busy —
   minutes at best, and the board's refresh button cannot ask someone to wait
   that long to see whether their last edit landed. One state is one query. */
const ONLY = (process.argv.find((a) => a.startsWith("--state=")) || "").split("=")[1] || null;
const SINCE = (process.argv.find((a) => a.startsWith("--since=")) || "").split("=")[1] || null;
const states = ONLY ? [ONLY] : Object.keys(STATE_DATA);
const MIRRORS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ask(code, attempt = 0) {
  const q = `[out:json][timeout:120];area["ISO3166-2"="US-${code}"][admin_level=4]->.a;` +
            `(nwr["amenity"="charging_station"](area.a);` +
            `nwr["charging_station"="yes"](area.a););out bb tags;`;
  const url = MIRRORS[attempt % MIRRORS.length];
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "charge-board/1.0 (local snapshot refresh)" },
    body: new URLSearchParams({ data: q }),
    signal: AbortSignal.timeout(180000),
  });
  const text = await res.text();
  if (!res.ok || text.trimStart().startsWith("<")) throw new Error(`${res.status} busy`);
  return JSON.parse(text);
}

/* --since=<timestamp>: ask what changed instead of asking for everything.

   Overpass's `newer:` filter selects elements edited after a moment, so one
   query returns the couple of hundred stations that moved since the snapshot
   rather than all 13,600 — 76 KB against 2 MB, and one request against 51.
   Measured on the public instance: 53 s for the delta, six to twenty minutes
   for the sweep.

   The bounding box replaces the `area["ISO3166-1"="US"]` lookup, which is what
   most of that time was being spent on. It reaches into Canada and Mexico, so a
   handful of foreign stations can enter the snapshot; they are harmless, since
   nothing on this board is near enough to match one.

   What a delta cannot see: an element deleted upstream, or one that stopped
   being a charging station, simply does not come back in any answer — so those
   linger until a full sweep or a per-state refresh prunes them. */
if (SINCE) {
  const q = `[out:json][timeout:220][bbox:18.0,-180.0,72.0,-66.0];` +
            `(nwr["amenity"="charging_station"](newer:"${SINCE}");` +
            `nwr["charging_station"="yes"](newer:"${SINCE}"););out bb tags;`;
  report(`asking OpenStreetMap what changed since ${SINCE.slice(0, 16).replace("T", " ")}…`);
  let body = null;
  for (let attempt = 0; attempt < 4 && !body; attempt++) {
    try {
      const res = await fetch(MIRRORS[attempt % MIRRORS.length], {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "charge-board/1.0 (delta)" },
        body: new URLSearchParams({ data: q }),
        signal: AbortSignal.timeout(300000),
      });
      const text = await res.text();
      if (!res.ok || text.trimStart().startsWith("<")) throw new Error(`${res.status} busy`);
      body = JSON.parse(text);
    } catch (e) {
      console.log(`  attempt ${attempt + 1}: ${e.message}`);
      if (attempt === 3) { console.log("delta failed; snapshot left alone"); process.exit(1); }
      await sleep(6000 * (attempt + 1));
    }
  }
  const fresh = splitOsm(body.elements);
  const before = JSON.parse(readFileSync(OUT, "utf8"));
  const sitesNow = new Map(before.sites.map((x) => [x.id, x]));
  const hostsNow = new Map((before.hosts || []).map((x) => [x.id, x]));
  /* Deleted from the other bucket as well as set in its own: a station retagged
     to a plain shop that mentions charging — or the reverse — comes back in one
     of these two lists, and leaving the old copy behind would have the snapshot
     holding it as both at once. */
  let added = 0;
  for (const x of fresh.sites) { if (!sitesNow.has(x.id)) added++; sitesNow.set(x.id, x); hostsNow.delete(x.id); }
  for (const x of fresh.hosts) { if (!hostsNow.has(x.id)) added++; hostsNow.set(x.id, x); sitesNow.delete(x.id); }
  const changed = fresh.sites.length + fresh.hosts.length;
  const stamp = body.osm3s?.timestamp_osm_base || before.generated;
  writeFileSync(`${OUT}.new`, JSON.stringify({ ...before, generated: stamp,
    sites: [...sitesNow.values()], hosts: [...hostsNow.values()] }));
  renameSync(`${OUT}.new`, OUT);
  console.log(`delta: ${changed} changed (${added} new, ${changed - added} updated)` +
              ` · ${sitesNow.size} stations, ${hostsNow.size} hosts · base ${before.generated} -> ${stamp}`);
  report("");
  process.exit(0);
}

const byId = new Map();
let newest = null; let failed = [];
for (const [i, code] of states.entries()) {
  let got = false;
  for (let attempt = 0; attempt < 4 && !got; attempt++) {
    try {
      const body = await ask(code, attempt);
      for (const el of body.elements) byId.set(`${el.type[0]}${el.id}`, el);
      const ts = body.osm3s?.timestamp_osm_base;
      if (ts && (!newest || ts > newest)) newest = ts;
      got = true;
      process.stdout.write(`${code}:${body.elements.length} `);
    } catch (e) {
      if (attempt === 3) { failed.push(code); process.stdout.write(`${code}:FAIL `); }
      else await sleep(4000 * (attempt + 1));
    }
  }
  if ((i + 1) % 10 === 0) process.stdout.write("\n");
  report(`OpenStreetMap: ${i + 1} of ${states.length} states`);
  await sleep(1200);                      // pace it; this is someone else's server
}
console.log();

for (let pass = 0; pass < 3 && failed.length; pass++) {
  report(`retrying ${failed.join(", ")}`);
  console.log(`retrying ${failed.join(", ")} (pass ${pass + 1})`);
  const again = [];
  for (const code of failed) {
    let got = false;
    for (let attempt = 0; attempt < 3 && !got; attempt++) {
      try {
        const body = await ask(code, attempt + pass);
        for (const el of body.elements) byId.set(`${el.type[0]}${el.id}`, el);
        const ts = body.osm3s?.timestamp_osm_base;
        if (ts && (!newest || ts > newest)) newest = ts;
        got = true;
        console.log(`  ${code}: ${body.elements.length}`);
      } catch { await sleep(8000 * (attempt + 1)); }
    }
    if (!got) again.push(code);
  }
  failed = again;
  if (failed.length) await sleep(20000);
}

const { sites, hosts } = splitOsm([...byId.values()]);
console.log(`\n${byId.size} elements, ${sites.length} stations and ${hosts.length} hosts with a position,` +
            ` ${sites.filter((s) => s.ext).length} carrying an extent`);
if (failed.length) console.log(`states that would not answer: ${failed.join(", ")}`);

const before = JSON.parse(readFileSync(OUT, "utf8"));
const withExt = sites.filter((s) => s.ext).length;

if (ONLY) {
  // Drop what the snapshot held inside this state's outline and put the fresh
  // result in its place, so elements deleted upstream disappear too. The file's
  // `generated` stamp is left alone: most of it is still as old as it was, and
  // advancing it would overstate the whole board's freshness.
  if (failed.length) { console.log(`refusing to merge: ${ONLY} would not answer`); process.exit(1); }
  const rings = STATE_DATA[ONLY]?.rings || [];
  const inside = (lon, lat) => rings.some((ring) => {
    let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  });
  /* Drop by id as well as by outline. Overpass selects on the administrative
     area; `inside` tests a simplified outline from states.json, and near a
     border the two disagree — an element the query returned may sit outside the
     simplified polygon, survive the filter, and be added a second time. */
  // One id set across both buckets, so an element that changed kind is dropped
  // from wherever the snapshot used to hold it before the fresh copy goes in.
  const fresh = new Set([...sites, ...hosts].map((x) => x.id));
  const outside = (o) => !fresh.has(o.id) && !inside(o.lon, o.lat);
  const kept = before.sites.filter(outside);
  const keptHosts = (before.hosts || []).filter(outside);
  const merged = { ...before, sites: [...kept, ...sites], hosts: [...keptHosts, ...hosts] };
  writeFileSync(`${OUT}.new`, JSON.stringify(merged));
  renameSync(`${OUT}.new`, OUT);
  console.log(`\n${ONLY}: ${before.sites.length - kept.length} replaced by ${sites.length}` +
              ` · file now ${merged.sites.length} stations, ${merged.hosts.length} hosts` +
              ` · base ${before.generated} (unchanged)`);
  process.exit(0);
}
if (failed.length) {
  console.log(`refusing to replace: ${failed.join(", ")} never answered, the file would be missing them`);
  process.exit(1);
}
if (sites.length < before.sites.length * 0.95) {
  console.log(`refusing to replace: got ${sites.length}, previous file has ${before.sites.length}`);
  process.exit(1);
}
if (withExt < 500) {
  console.log(`refusing to replace: only ${withExt} elements carry an extent — the query lost its areas again`);
  process.exit(1);
}
report("writing the new snapshot…");
const payload = { source: "OpenStreetMap via Overpass", license: "ODbL", generated: newest, sites, hosts };
writeFileSync(`${OUT}.new`, JSON.stringify(payload));
renameSync(`${OUT}.new`, OUT);
console.log(`\nwritten: ${sites.length} stations, ${hosts.length} hosts` +
            ` · ${(statSync(OUT).size / 1e6).toFixed(2)} MB · base ${newest}`);
console.log(`previous: ${before.sites.length} stations · base ${before.generated}`);
