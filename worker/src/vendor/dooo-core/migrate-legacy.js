// migrate-legacy.js — one-time drain of the pre-Stage-4 unscoped IndexedDB.
//
// The gap this closes: a device queues offline captures in the unscoped DB
// (e.g. 'predo'), then the user signs in — the app now opens the SCOPED DB
// ('predo__<household>') and those queued mutations would be stranded. On the
// first scoped boot, call drainLegacyOutbox(oldName, push): it replays the old
// outbox through the app's (now authenticated) transport, then marks the old
// DB drained so this never re-runs. Server-side LWW/dedup makes replays
// idempotent, so a crash mid-drain is safe.

import { openDB, STORES, idbAvailable } from "./idb.js";

const DRAINED_KEY = "legacy.drained";

export async function drainLegacyOutbox(oldDbName, transportPush) {
  if (!idbAvailable()) return { drained: 0, skipped: true };

  // Don't create the legacy DB if it never existed (indexedDB.databases()
  // is available on all suite targets; fall back to open-and-inspect).
  if (typeof indexedDB.databases === "function") {
    try {
      const names = (await indexedDB.databases()).map((d) => d.name);
      if (!names.includes(oldDbName)) return { drained: 0, skipped: true };
    } catch {
      /* fall through to open */
    }
  }

  const db = await openDB(oldDbName);
  try {
    if (await db.metaGet(DRAINED_KEY)) return { drained: 0, skipped: true };
    const queued = await db.getAll(STORES.outbox);
    if (queued.length) {
      // Same record shape the app's own SyncEngine pushes — transport-agnostic.
      const result = await transportPush(queued.map((q) => q.record ?? q));
      if (result && result.ok === false) {
        throw new Error(result.error || "legacy outbox push failed");
      }
      await db.clear(STORES.outbox);
    }
    await db.metaSet(DRAINED_KEY, new Date().toISOString());
    return { drained: queued.length, skipped: false };
  } finally {
    db.db.close();
  }
}
