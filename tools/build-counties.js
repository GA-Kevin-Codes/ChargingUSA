/* Turn the Census Bureau's county boundaries into data/counties/XX.json, one
   file per state, for the board's county zoom.

   The source is us-atlas's counties-10m.json: the Census cartographic county
   boundaries (2017 edition, public domain), simplified and quantized as
   TopoJSON by Mike Bostock (ISC). It is decoded here without a TopoJSON
   library — the format is small enough to read by hand — and written out as
   plain rings, because the board draws them on a canvas and tests sites
   against them, and needs nothing more.

   One file per state, so opening a state costs that state's counties and not
   the country's. Coordinates are kept to three decimals, about 100 m, which is
   finer than the source's own simplification.

   Run once, or when the boundaries change (they rarely do):
     bun tools/build-counties.js
     bun tools/build-counties.js --src=path/to/counties-10m.json   */
import { readFileSync, writeFileSync, mkdirSync } from "fs";

const OUT = new URL("../data/counties/", import.meta.url).pathname;
const SRC = process.argv.find((a) => a.startsWith("--src="))?.split("=")[1];
const URL_ = "https://cdn.jsdelivr.net/npm/us-atlas@3.0.1/counties-10m.json";

const topo = SRC ? JSON.parse(readFileSync(SRC, "utf8"))
  : await (await fetch(URL_)).json();

// state FIPS → postal code
const FIPS = {
  "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE", "11": "DC",
  "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY",
  "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO", "30": "MT",
  "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH",
  "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT",
  "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI", "56": "WY", "72": "PR",
};

/* Arcs are delta-encoded integers on a grid; `transform` puts them back in
   degrees. An arc index below zero means the arc read backwards (~i). */
const [sx, sy] = topo.transform.scale, [tx, ty] = topo.transform.translate;
const arcs = topo.arcs.map((arc) => {
  let x = 0, y = 0;
  return arc.map(([dx, dy]) => { x += dx; y += dy; return [x * sx + tx, y * sy + ty]; });
});
const r3 = (v) => Math.round(v * 1000) / 1000;
function ring(ids) {
  const out = [];
  for (const i of ids) {
    const a = i < 0 ? arcs[~i].slice().reverse() : arcs[i];
    // consecutive arcs share their joining point; drop the repeat
    for (let k = out.length ? 1 : 0; k < a.length; k++) {
      const p = [r3(a[k][0]), r3(a[k][1])];
      const last = out[out.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
    }
  }
  return out;
}

/* What to call it. The source gives the bare name — "Hillsborough" — and the
   word after it depends on the state: a parish in Louisiana, a borough or
   census area in Alaska (where the bare name is all there is), and in
   Virginia a county and an independent city can share a name, so the cities
   (FIPS 5xx and up) say so. */
function label(fips, name, st) {
  if (st === "LA") return `${name} Parish`;
  if (st === "AK" || st === "DC" || st === "PR") return name;
  if (st === "VA" && Number(fips.slice(2)) >= 500) return `${name} (city)`;
  if (/ city$/i.test(name)) return name;
  return `${name} County`;
}

const by = {};
for (const g of topo.objects.counties.geometries) {
  const st = FIPS[String(g.id).slice(0, 2)];
  if (!st || !g.arcs) continue;
  const polys = g.type === "Polygon" ? [g.arcs] : g.arcs;
  // outer rings and holes alike: the board tests with even-odd, which handles both
  const rings = polys.flatMap((p) => p.map(ring)).filter((r) => r.length >= 3);
  (by[st] ||= []).push({ id: String(g.id), name: label(String(g.id), g.properties.name, st), rings });
}

mkdirSync(OUT, { recursive: true });
let total = 0;
for (const [st, list] of Object.entries(by)) {
  list.sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(`${OUT}${st}.json`, JSON.stringify({ state: st, source: "US Census Bureau cartographic boundaries 2017, via us-atlas", counties: list }));
  total += list.length;
}
console.log(`${total} counties in ${Object.keys(by).length} state files`);
