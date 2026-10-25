/* Which site is this, and what has this browser already done to it.

   Loaded before app.js and edit.js: the board reads it to count work the
   snapshot has not caught up with, and the editor writes it. Kept in a file of
   its own so that any page loading the editor without the board still shares
   one definition of identity, rather than two drifting apart.

   Plain globals rather than a module: these pages are classic scripts sharing
   one lexical scope, which is what lets app.js and edit.js see each other. */

const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
};

/* ------------------------------------------------- what this browser has done

   The editor writes its own history to localStorage — which sites have been
   mapped, skipped or noted — and the board reads it back so its figures reflect
   work that has happened but has not come round in a snapshot yet. Identity has
   to mean the same thing on both sides, so it is defined once, here.  */

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
/* Remembered with the time it happened, because the board has to be able to
   ask "has the snapshot caught up with this yet?" — see `localOverlay`. Older
   entries were a bare list of keys; they are read back at time zero, which
   means the snapshot always looks newer and they never claim anything. */
const remember = (bucket, s) => {
  const list = rememberList(bucket);
  const k = keyOf(s);
  if (!list.some((e) => e.k === k)) {
    list.push({ k, at: Date.now() });
    store.set(bucket, list.slice(-4000));
  }
};
const rememberList = (bucket) =>
  (store.get(bucket, []) || []).map((e) => (typeof e === "string" ? { k: e, at: 0 } : e));
/* The keys alone, as a Set. This is how a bucket is read for membership: the
   entries themselves are {k, at} records, so a Set built straight from the
   stored list holds objects and answers no for every key. */
const rememberKeys = (bucket) => new Set(rememberList(bucket).map((e) => e.k));
/* Drop every entry whose key is in `keys` — how a skipped site is brought back. */
const forget = (bucket, keys) => {
  const list = rememberList(bucket);
  const kept = list.filter((e) => !keys.has(e.k));
  if (kept.length !== list.length) store.set(bucket, kept);
};
