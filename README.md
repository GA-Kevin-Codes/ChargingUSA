# ChargingUSA

Every public DC fast-charging site in the US, counted per site rather than per
plug, and measured against what OpenStreetMap already holds.

The board is static: open `index.html` and it reads the saved payloads in
`data/`. `tools/` refreshes those payloads and runs hourly from GitHub Actions —
OpenStreetMap incrementally every hour, the slower sources once a day.

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
