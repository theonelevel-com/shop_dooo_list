// sync-engine.js — the shared incremental, last-write-wins sync engine.
//
// Generalises to.dooo's proven model (incremental push of items changed since
// lastSync; conflict resolution by `updatedAt` ISO timestamp; tombstones ride
// as normal records) into one engine every suite app can drive. The app supplies
// a TRANSPORT (how to talk to its dooo-api endpoint) and, optionally, a mapping
// between its in-memory shape and flat records. Everything else — local store,
// outbox, dedup, retry/backoff, online/offline, Background Sync — lives here.
//
// CONFLICT MODEL (unchanged from to.dooo, which is battle-tested):
//   • Pull merge: the REMOTE copy wins when remote.updatedAt >= local.updatedAt
//     (exact ties favour the server). Otherwise the local copy is kept — so a
//     newer un-pushed local edit is never clobbered by a stale pull.
//   • Push: server upserts WHERE excluded.updated_at > todos.updated_at (strict),
//     so exact ties favour the server's existing copy. Re-sends are idempotent.
//   • Every local mutation stamps updatedAt = now → most-recently-edited wins.
//   • Records missing updatedAt fall back to epoch (they lose conflicts).
//
// TRANSPORT contract (app-supplied adapter):
//   pull(sinceIso|null) -> Promise<record[]>          // all records (or delta)
//   push(records)       -> Promise<{ ok, error? }>     // upsert batch, LWW server-side
// Records are plain objects with at least { id, [conflictKey] }.

import { openDB, STORES, idbAvailable } from "./idb.js";
import { Outbox } from "./queue.js";
import { SeenHashes, contentHash } from "./dedup.js";

const MAX_RETRIES = 3;
const BACKOFF_MS = 3000;

export class SyncEngine {
  constructor(opts) {
    const {
      name, // IndexedDB database name, unique per app (e.g. "todooo")
      scope = null, // tenant/user id — namespaces the local DB so a device that
      //             signs in as a different user (Stage 4 multi-tenant) never
      //             merges two people's data. null → single-tenant today.
      transport, // { pull, push }
      version = 1,
      conflictKey = "updatedAt",
      stores = null, // extra IDB store descriptors, if any
      dedupeField = null, // record field to content-hash for capture dedup (e.g. "text")
      pollMs = 30000, // background poll cadence when online (to.dooo uses 30s)
      backgroundSyncTag = "dooo-sync",
      onStatus = () => {}, // ('synced'|'syncing'|'error'|'offline'|'setup') => void
      onRecords = () => {}, // (record[]) => void — fires after local store changes
      now = () => new Date().toISOString(),
    } = opts;

    if (!name) throw new Error("SyncEngine: `name` is required");
    if (!transport || !transport.pull || !transport.push)
      throw new Error("SyncEngine: transport must implement pull() and push()");

    this.name = name;
    this.scope = scope;
    this.dbName = scope ? `${name}__${scope}` : name;
    this.transport = transport;
    this.version = version;
    this.conflictKey = conflictKey;
    this.stores = stores;
    this.dedupeField = dedupeField;
    this.pollMs = pollMs;
    this.backgroundSyncTag = backgroundSyncTag;
    this.onStatus = onStatus;
    this.onRecords = onRecords;
    this.now = now;

    this.idb = null;
    this.outbox = null;
    this.seen = null;
    this._pollTimer = null;
    this._syncing = false;
    this._queuedWhileSyncing = false;
    this._retries = 0;
    this._writeAuthFailed = false;
    this._started = false;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  async init() {
    if (!idbAvailable()) throw new Error("IndexedDB unavailable in this context");
    this.idb = await openDB(this.dbName, this.version, this.stores);
    this.outbox = new Outbox(this.idb);
    if (this.dedupeField) this.seen = new SeenHashes(this.idb);
    return this;
  }

  // Begin online/offline listeners + polling. Call after init() and after the
  // transport is configured (endpoint + token present).
  start() {
    if (this._started) return this;
    this._started = true;
    this._onOnline = () => this.sync().catch(() => {});
    this._onOffline = () => this.onStatus("offline");
    addEventListener("online", this._onOnline);
    addEventListener("offline", this._onOffline);
    if (this.pollMs > 0) {
      this._pollTimer = setInterval(() => {
        if (navigator.onLine !== false) this.sync().catch(() => {});
      }, this.pollMs);
    }
    return this;
  }

  stop() {
    this._started = false;
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._pollTimer = null;
    removeEventListener("online", this._onOnline);
    removeEventListener("offline", this._onOffline);
    return this;
  }

  // ── local reads ──────────────────────────────────────────────────────────────

  async all() {
    return this.idb.getAll(STORES.records);
  }

  async get(id) {
    return this.idb.get(STORES.records, id);
  }

  // ── local writes (offline-first) ─────────────────────────────────────────────
  //
  // Write locally FIRST, enqueue for push, then attempt a push. The record is
  // safe the moment it hits IndexedDB; the network is best-effort from there.

  // Upsert a record. Stamps updatedAt. If a dedupeField is configured, a capture
  // whose normalised-text hash was already seen is dropped (returns {deduped}).
  async put(record) {
    const rec = { ...record };
    rec[this.conflictKey] = this.now();

    if (this.dedupeField && rec[this.dedupeField] != null) {
      const hash = await contentHash(rec[this.dedupeField]);
      rec._hash = hash;
      if (await this.seen.has(hash)) {
        return { ok: true, deduped: true, id: rec.id };
      }
      await this.seen.add(hash);
    }

    await this.idb.put(STORES.records, rec);
    await this.outbox.enqueue(rec, "upsert");
    this.onRecords(await this.all());
    this._pushSoon();
    return { ok: true, id: rec.id, record: rec };
  }

  // Upsert a record that already carries its own conflict timestamp (the caller
  // stamps updatedAt at mutation time — e.g. to.dooo). Unlike put(), this does
  // NOT re-stamp, so an incremental "changed since lastSync" filter stays valid.
  // Enqueues for push; does not auto-trigger a sync (the caller drives that).
  async upsertLocal(record) {
    await this.idb.put(STORES.records, record);
    await this.outbox.enqueue(record, "upsert");
    return { ok: true, id: record.id };
  }

  // Soft-delete → tombstone. The record stays locally (deleted:true) and is
  // pushed so the deletion propagates and wins by updatedAt on every device.
  // (Apps that keep a hidden __deleted__ bucket can map that in their transport.)
  async remove(id) {
    const existing = await this.get(id);
    if (!existing) return { ok: true, missing: true };
    const rec = { ...existing, deleted: true, [this.conflictKey]: this.now() };
    await this.idb.put(STORES.records, rec);
    await this.outbox.enqueue(rec, "delete");
    this.onRecords(await this.all());
    this._pushSoon();
    return { ok: true, id };
  }

  // ── merge ────────────────────────────────────────────────────────────────────

  // Merge a batch of remote records into the local store using the conflict
  // model above. Returns the merged record list.
  async _merge(remote) {
    const localArr = await this.all();
    const local = new Map(localArr.map((r) => [r.id, r]));

    for (const inc of remote) {
      const cur = local.get(inc.id);
      if (!cur) {
        local.set(inc.id, inc);
        continue;
      }
      const incT = ts(inc[this.conflictKey]);
      const curT = ts(cur[this.conflictKey]);
      if (incT >= curT) local.set(inc.id, inc); // server newer-or-equal wins
      // else keep local (newer un-pushed edit)
    }

    const merged = [...local.values()];
    await this.idb.putMany(STORES.records, merged);
    return merged;
  }

  // ── sync ──────────────────────────────────────────────────────────────────────

  // Pull remote → merge locally.
  async pull() {
    const since = await this.idb.metaGet("lastSync", null);
    const remote = await this.transport.pull(since);
    if (!Array.isArray(remote)) throw new Error("transport.pull did not return an array");
    const merged = await this._merge(remote);
    await this.idb.metaSet("lastSync", this.now());
    this.onRecords(merged);
    return merged;
  }

  // Drain the outbox: coalesce to one mutation per id, push, remove on success.
  async push() {
    const rows = await this.outbox.coalesced(this.conflictKey);
    if (!rows.length) return { ok: true, pushed: 0 };
    const records = rows.map((r) => r.record);
    const res = await this.transport.push(records);
    if (res && res.ok) {
      await this.outbox.remove(rows.map((r) => r.seq));
      this._writeAuthFailed = false;
      return { ok: true, pushed: records.length };
    }
    if (isUnauthorized(res)) {
      this._writeAuthFailed = true;
      this.onStatus("error");
      return { ok: false, unauthorized: true };
    }
    return { ok: false, error: (res && res.error) || "push failed" };
  }

  // Full sync: push local changes, then pull + reconcile. Serialised so two
  // syncs never overlap; a sync requested mid-flight is coalesced into one re-run.
  async sync() {
    if (this._syncing) {
      this._queuedWhileSyncing = true;
      return;
    }
    if (navigator.onLine === false) {
      this.onStatus("offline");
      return;
    }
    this._syncing = true;
    this.onStatus("syncing");
    try {
      const pushed = await this.push();
      await this.pull();
      this._retries = 0;
      this.onStatus(this._writeAuthFailed ? "error" : "synced");
      if (pushed && pushed.unauthorized) this.onStatus("error");
    } catch (e) {
      this.onStatus("offline");
      if (this._retries < MAX_RETRIES) {
        this._retries++;
        setTimeout(() => this.sync().catch(() => {}), BACKOFF_MS * this._retries);
      }
    } finally {
      this._syncing = false;
      if (this._queuedWhileSyncing) {
        this._queuedWhileSyncing = false;
        this.sync().catch(() => {});
      }
    }
  }

  // Debounced push after a local write (batches rapid edits).
  _pushSoon() {
    if (this._pushTimer) clearTimeout(this._pushTimer);
    this._pushTimer = setTimeout(() => this.sync().catch(() => {}), 800);
  }

  // ── Background Sync ────────────────────────────────────────────────────────────
  //
  // Register a one-off Background Sync so the SERVICE WORKER drains the outbox
  // after the page is gone. The SW must listen for the same tag and postMessage
  // the page (or run its own minimal push). See README for the SW snippet.
  async requestBackgroundSync(swRegistration) {
    try {
      const reg = swRegistration || (await navigator.serviceWorker?.ready);
      if (reg && "sync" in reg) await reg.sync.register(this.backgroundSyncTag);
      return true;
    } catch {
      return false; // Background Sync unsupported (Safari) — poll/online covers it
    }
  }
}

// ── helpers ────────────────────────────────────────────────────────────────────

function ts(v) {
  const t = v ? new Date(v).getTime() : 0;
  return Number.isFinite(t) ? t : 0;
}

function isUnauthorized(res) {
  if (!res) return false;
  if (res.status === 401 || res.unauthorized) return true;
  return typeof res.error === "string" && /unauth/i.test(res.error);
}
