# ChargingUSA

Every public DC fast-charging site in the US, counted per site rather than per
plug, and measured against what OpenStreetMap already holds.

The board is static: open `index.html` and it reads the saved payloads in
`data/`. `tools/` refreshes those payloads and runs hourly from GitHub Actions —
OpenStreetMap incrementally every hour, the slower sources once a day.

## The look

The board is drawn as a road atlas, and colour means what a highway sign makes
it mean: guide green is *on the map*, work-zone orange is *missing*, service
blue is something you can do. It follows the system between a paper ground by
day and asphalt by night, and the button in the header overrides that. The
whole palette is the block of custom properties at the top of `index.html`;
the map and the editor paint their canvases from the same tokens, so change a
value there rather than in the scripts.

## Level 2

The board is about fast charging by default. The **Level 2** switch adds
AFDC's Level 2 stations — about 68,000 records, Tesla's destination chargers
among them — from `data/afdc-l2.json`, which the daily refresh writes and the
page loads only when the switch is on. A network's Level 2 posts beside its
fast chargers become one site with both. Level 2 sites are proposed with
`frequency=60`, fast ones with `frequency=0`, and a site with both gets
`frequency=0;60`.

## Sources

| | |
|---|---|
| **AFDC** (US DOE / NREL) | station inventory · US Government, public domain |
| **supercharge.info** | Tesla sites and their build pipeline |
| **All the Places** | Electrify America and IONNA |
| **OpenStreetMap** | what is already mapped · © OpenStreetMap contributors |

Positions published by an operator are leads, not surveys. Anything drawn from
this board onto OpenStreetMap should be checked against imagery first — which is
what the built-in editor is for.

## What the editor proposes, and from what

Each site gets one *inventory* (`siteInventory` in `app.js`): its ports — one
vehicle charging — grouped into kinds, each with its cables and what each cable
delivers. Tags, the dispensers offered for placing, the station totals and the
GeoJSON export are all read off it, so they cannot disagree with one another.

- Two AFDC records are one site only when they are the same network — AFDC's
  `ev_network`, which is what the editor proposes as `brand` — and
  either give the same address or stand within 80 m of each other under the
  same host's name. Standing nearby is not enough on its own: coordinates are
  wrong often enough that unrelated records land on one spot. The records
  behind a joined site are listed in the editor.
- `capacity` is ports, never cables. A twin-head cabinet is one port.
- `socket:<type>` is cables of that type; `socket:<type>:output` is that
  connector's own figure, never the cabinet's best.
- Where two sources count a site differently both figures are shown, and where
  a value already on the map differs from the sources it is kept unless the
  mapper ticks it.
- Free text becomes a tag only when it parses cleanly, and is otherwise shown
  in the source's own words. A price is written as `fee=yes` and never as
  `charge`: tariffs change too often for the amount to be worth mapping.
- `access=yes` is for a site open widely to the public. One limited to a set
  of customers — a hotel's guests, or one make of vehicle, such as a
  Tesla-only Supercharger — is `access=customers`. Where the source narrows
  it some other way (staff, a permit, "call ahead") nothing is proposed.
- The address is proposed by default. The street is written out in full and
  stops at its type word — "555 W 44th St PUBLIC WORKS" is `West 44th Street`,
  and the rest is shown as where on the property to look.
- An open date that many sites of one network share is a batch-load date and is
  not written as `start_date`.

`tools/stress.js` runs every site through that same code and checks the
arithmetic, including against a second, independent reading of the raw
payload:

```bash
bun tools/stress.js
```

```bash
bun tools/stress.js --l2
```

The second form runs with the Level 2 switch on. Either exits non-zero if an
invariant fails, and lists how often each kind of source disagreement occurs. Run it after changing the merge, the inventory or
the tag proposals.

## Licensing

The `LICENSE` file (CC0 1.0) covers **the code in this repository** — the board,
the editor and the refresh scripts.

It does **not** cover everything in `data/`, because those parts are not mine to
place in the public domain:

- **`data/osm.json` is derived from OpenStreetMap** and stays under the
  [Open Database License](https://opendatacommons.org/licenses/odbl/). ODbL is
  share-alike: a derived database has to carry the same terms and the same
  attribution. Reusing it means keeping both.
- **`data/brands.json` is 67 operator logos**, each the trademark of the company
  it belongs to. They are here so the board can label a network at a glance.
  Neither CC0 nor ODbL applies to them, and no permission to reuse them is
  granted or implied by this repository.
- The AFDC-derived payloads are US Government work and are public domain.

If you want a copy of this data under one clean licence, take the AFDC portions
and re-derive the rest from source.
