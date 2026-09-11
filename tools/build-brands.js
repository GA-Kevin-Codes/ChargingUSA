/* Turn icons/ plus the brand table below into data/brands.json.

   Re-runnable: drop a new SVG into icons/, add a row here, run
   `bun tools/build-brands.js`. The icons ship as files rather than inlined,
   so a brand's mark is cached once by the browser instead of riding along in
   every fetch of the brand table.
   
   `-dark` files are the mark drawn for a dark ground — white where the base is
   navy. The board is dark only, so those win wherever they exist. */
import { readdirSync, readFileSync, writeFileSync } from "fs";

const ICONS = new URL("../icons/", import.meta.url).pathname;
const OUT = new URL("../data/brands.json", import.meta.url).pathname;

/* The vocabulary, three ways.
   
   `name` is what the board prints — taken from the operator's own styling, so
   "bp pulse" and "EVgo" rather than the shouted forms the feeds publish.
   `qid` is the Wikidata item for the company, which the editor writes as
   `brand:wikidata` without anyone having to look it up.
   `nets` are the raw names the sources use for it; the board maps every one of
   them onto this row. Several feeds name the same company differently and two
   of them shout it, so this is where that is reconciled rather than in a
   display helper that only fixed the label. */
const BRANDS = [
  { name: "Tesla",             qid: "Q478214",     icon: "tesla",             nets: ["Tesla"] },
  { name: "Electrify America", qid: "Q59773555",   icon: "electrify-america", nets: ["Electrify America"] },
  { name: "EVgo",              qid: "Q61803820",   icon: "evgo",              nets: ["eVgo Network"] },
  { name: "ChargePoint",       qid: "Q5176149",    icon: "chargepoint",       nets: ["ChargePoint Network"] },
  { name: "Red E",             qid: "Q131416886",  icon: "red-e",             nets: ["RED_E"] },
  { name: "Blink",             qid: "Q62065645",   icon: "blink",             nets: ["Blink Network"] },
  { name: "EV Connect",        qid: "Q126652985",  icon: "ev-connect",        nets: ["EV Connect"] },
  { name: "IONNA",             qid: "Q124528707",  icon: "ionna",             nets: ["IONNA"] },
  { name: "Ford",              qid: "Q44294",      icon: "ford",              nets: ["FORD_CHARGE"] },
  { name: "Rivian",            qid: "Q7338847",    icon: "rivian",            nets: ["RIVIAN_ADVENTURE", "RIVIAN_WAYPOINTS"] },
  { name: "Francis Energy",    qid: "Q123565578",  icon: "francis-energy",    nets: ["FCN"] },
  { name: "EVCS",              qid: "Q117302781",  icon: "evcs",              nets: ["EVCS"] },
  { name: "bp pulse",          qid: "Q39057719",   icon: "bp-pulse",          nets: ["BP_PULSE"] },
  { name: "Walmart",           qid: "Q483551",     icon: "walmart",           nets: ["WALMART"] },
  { name: "Mercedes-Benz",     qid: "Q36008",      icon: "mercedes-benz",     nets: ["MERCEDES_BENZ"] },
  { name: "EV Gateway",        qid: "Q127869937",  icon: "ev-gateway",        nets: ["EVGATEWAY"] },
  { name: "Shell Recharge",    qid: "Q105883058",  icon: "shell-recharge",    nets: ["SHELL_RECHARGE"] },
  { name: "ChargeSmart",       qid: "Q140026497",  icon: "chargesmart",       nets: ["CHARGESMART_EV"] },
  { name: "ViaLynk",           qid: null,          icon: "vialynk",           nets: ["VIALYNK"] },
  { name: "FPL EVolution",     qid: "Q138574160",  icon: "fpl-evolution",     nets: ["FPLEV"] },
  { name: "ChargeLab",         qid: "Q128770776",  icon: "chargelab",         nets: ["CHARGELAB"] },
  { name: "Applegreen",        qid: "Q7178908",    icon: "applegreen",        nets: ["APPLEGREEN"] },
  { name: "Circle K",          qid: "Q3268010",    icon: "circle-k",          nets: ["CIRCLE_K"] },
  { name: "SWTCH",             qid: "Q127502151",  icon: "swtch",             nets: ["SWTCH"] },
  { name: "Noodoe",            qid: null,          icon: "noodoe",            nets: ["NOODOE"] },
  { name: "Nayax",             qid: "Q39052983",   icon: "nayax",             nets: ["NAYAX_ENERGY"] },
  { name: "Supercharger for Business", qid: null,  icon: "tesla-supercharger-business", nets: ["US_SUPERCHARGE"] },
  { name: "FLO",               qid: "Q55596927",   icon: "flo",               nets: ["FLO"] },
  { name: "7-Eleven",          qid: "Q259340",     icon: "7-eleven",          nets: ["7CHARGE"] },
  { name: "Electric Era",      qid: null,          icon: "electric-era",      nets: ["ELECTRIC_ERA"] },
  { name: "OpConnect",         qid: "Q127700932",  icon: "opconnect",         nets: ["OpConnect"] },
  { name: "Loop",              qid: "Q135741953",  icon: "loop",              nets: ["LOOP"] },
  { name: "Kwik Trip",         qid: "Q6450420",    icon: "kwik-trip",         nets: ["KWIK_CHARGE"] },
  { name: "Graviti Energy",    qid: "Q134591515",  icon: "graviti-energy",    nets: ["GRAVITI_ENERGY"] },
  { name: "ABM",               qid: "Q4650338",    icon: "abm",               nets: ["ABM"] },
];

/* Names the board prints for networks that have no brand row — no icon, no
   Wikidata item, just a label that should not be shouted or underscored. */
const PLAIN = {
  "Non-Networked": "Independent",
  UNIVERSAL: "Universal EV",
  SYNERGEV: "SynergEV",
  EVRANGE: "EV Range",
  POWERFLEX: "PowerFlex",
  WATT_EV: "WattEV",
  CHAEVI: "CHAEVI",
  AUTEL: "Autel",
  QUICKCHARGE: "QuickCharge",
};

const have = new Set(readdirSync(ICONS).filter((f) => f.endsWith(".svg")).map((f) => f.slice(0, -4)));
const brands = {}, nets = {}, missing = [];
for (const b of BRANDS) {
  const file = have.has(`${b.icon}-dark`) ? `${b.icon}-dark` : have.has(b.icon) ? b.icon : null;
  if (!file) missing.push(b.icon);
  brands[b.name] = { qid: b.qid || null, icon: file ? `icons/${file}.svg` : null };
  for (const n of b.nets) nets[n] = b.name;
}
for (const [n, name] of Object.entries(PLAIN)) {
  nets[n] = name;
  brands[name] ??= { qid: null, icon: null };
}

writeFileSync(OUT, JSON.stringify({ brands, nets }, null, 1));
console.log(`${Object.keys(brands).length} brands · ${Object.keys(nets).length} network names mapped`);
console.log(`${Object.values(brands).filter((b) => b.icon).length} with an icon, ` +
            `${Object.values(brands).filter((b) => b.qid).length} with a Wikidata id`);
if (missing.length) console.log(`no svg for: ${missing.join(", ")}`);
