// queue.js — the outbound mutation queue ("outbox").
//
// Every local write that must reach the server is appended here FIRST, then the
// live record is updated. The engine drains the outbox when connectivity is
// available; the service worker's Background Sync event drains it after the app
// is closed. This is what guarantees "the user never loses a capture even if
// they close the app before signal returns" (Stage 3 outcome).
//
// A queued mutation is just the record to upsert (or a tombstone). Because the
// server merges last-write-wins by updatedAt, re-sending a mutation is safe and
// idempotent — a stale re-send simply loses to a newer copy. So draining need
// not be exactly-once; at-least-once is correct.

import { STORES } from "./idb.js";

export class Outbox {
  constructor(idb) {
    this.idb = idb;
  }

  // Append a mutation. `record` is the full record (already stamped with
  // updatedAt); `op` is 'upsert' | 'delete' for callers that care, though the
  // server treats a tombstone as a normal upsert.
  async enqueue(record, op = "upsert") {
    await this.idb.put(STORES.outbox, {
      record,
      op,
      queuedAt: new Date().toISOString(),
    });
  }

  async all() {
    return this.idb.getAll(STORES.outbox);
  }

  async size() {
    return (await this.all()).length;
  }

  // Remove drained entries by their autoIncrement seq keys.
  async remove(seqs) {
    for (const seq of seqs) await this.idb.delete(STORES.outbox, seq);
  }

  async clear() {
    return this.idb.clear(STORES.outbox);
  }

  // Collapse to one entry per record id, keeping the newest by updatedAt. Avoids
  // pushing five stale copies of the same todo after five quick edits offline.
  async coalesced(conflictKey = "updatedAt") {
    const rows = await this.all();
    const byId = new Map();
    for (const row of rows) {
      const id = row.record && row.record.id;
      if (id == null) continue;
      const prev = byId.get(id);
      if (!prev) {
        byId.set(id, row);
        continue;
      }
      const a = new Date(row.record[conflictKey] || 0).getTime();
      const b = new Date(prev.record[conflictKey] || 0).getTime();
      if (a >= b) byId.set(id, row);
    }
    return [...byId.values()];
  }
}
