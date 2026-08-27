/* Rebuild live/data/*.json for the sources that are not OpenStreetMap.

   The board in preview mode reads saved payloads instead of calling the worker,
   so the refresh button has to regenerate them locally. What each source is and
   how it gets slimmed is decided in one place — worker.js — and this runs that
   same code rather than a second copy of it, the way refresh-osm.js does with
   slimOsm. A source that changes shape changes there and both follow.

   OpenStreetMap is deliberately not here: it is 51 queries against someone
   else's server and needs its own pacing, progress reporting and refusal
   rules. `--no-osm` is accepted and ignored, so the old call still works.

   Keys come from the environment, the same names the worker's secrets use:
     NLR_API_KEY   AFDC. Falls back to DEMO_KEY, which is rate limited to a
                   handful of calls an hour — fine for an occasional refresh,
                   not for a loop.
   supercharge.info, All the Places and the imagery index need no key. */
import { readFileSync, writeFileSync, renameSync, statSync } from "fs";

const OUT = new URL("../data", import.meta.url).pathname;
const PROGRESS = new URL("./progress.json", import.meta.url).pathname;
const JOB_TOKEN = process.env.CB_JOB || "";
const report = (note) => { try { writeFileSync(PROGRESS, JSON.stringify({ note, job: JOB_TOKEN, at: Date.now() })); } catch {} };

const src = readFileSync(new URL("./worker.js", import.meta.url).pathname, "utf8")
  .replace(/export default\s*\{/, "const _routes = {")
  .replace(/export\s*\{[^}]*\};?/g, "");
(0, eval)(src + "\n;Object.assign(globalThis,{ afdc, tesla, atp, imagery });");

const env = process.env;
/* `imagery` is left out of the default set: it is the Editor Layer Index, it
   changes about as often as a new aerial survey is published, and it is 6.6 MB
   to fetch. `--imagery` asks for it. */
const JOBS = [
  ["afdc",    "AFDC",                  () => afdc(env)],
  ["tesla",   "supercharge.info",      () => tesla(env)],
  ["ea",      "Electrify America",     () => atp(env, "electrify_america_us")],
  ["ionna",   "IONNA",                 () => atp(env, "ionna_us")],
  ...(process.argv.includes("--imagery")
    ? [["imagery", "Editor Layer Index", () => imagery()]] : []),
];

const only = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1];
let failed = [];
for (const [name, label, fn] of JOBS) {
  if (only && only !== name) continue;
  report(`refreshing ${label}…`);
  const before = (() => { try { return statSync(`${OUT}/${name}.json`).size; } catch { return 0; } })();
  try {
    const payload = await fn();
    const rows = Object.values(payload).find(Array.isArray)?.length ?? 0;
    /* Never replace a good file with an empty one. Every one of these sources
       has answered 200 with nothing in it at some point — an upstream mid-
       deploy, a spider that ran and found no matches — and a board showing
       zero sites is worse than one showing yesterday's. */
    if (!rows) throw new Error("came back with no rows");
    writeFileSync(`${OUT}/${name}.json.new`, JSON.stringify(payload));
    renameSync(`${OUT}/${name}.json.new`, `${OUT}/${name}.json`);
    const size = statSync(`${OUT}/${name}.json`).size;
    console.log(`${name}: ${rows} rows · ${(size / 1e6).toFixed(2)} MB` +
                (before ? ` (was ${(before / 1e6).toFixed(2)} MB)` : ""));
  } catch (e) {
    failed.push(`${name}: ${e.message}`);
    console.log(`${name}: FAILED — ${e.message} · kept the previous file`);
  }
}
report("");
if (failed.length) {
  console.log(`\n${failed.length} of ${JOBS.length} did not refresh:\n  ${failed.join("\n  ")}`);
  process.exit(1);
}
