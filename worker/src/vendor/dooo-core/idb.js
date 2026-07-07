// idb.js — tiny promise wrapper over IndexedDB. Zero dependencies.
//
// The suite's local store. Each app opens ONE database with three object stores:
//   • records  — the app's live data (todos / inbox items / list items), keyPath 'id'
//   • outbox   — queued outbound mutations awaiting push (drained on reconnect)
//   • meta     — small key/value bag (lastSync cursor, dedupe index, etc.)
//
// Nothing here is app-specific; SyncEngine drives it. localStorage remains a
// valid fallback for tiny state, but records live in IndexedDB so an app can
// hold thousands of items (shop.dooo's catalog) and read them fully offline.

const REQ = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

export const STORES = { records: "records", outbox: "outbox", meta: "meta" };

// Open (or upgrade) the database. `stores` defaults to the three standard stores;
// pass extra descriptors to add app-specific stores (e.g. shop.dooo's catalog).
export async function openDB(name, version = 1, stores = null) {
  const descriptors = stores || [
    { name: STORES.records, keyPath: "id" },
    { name: STORES.outbox, keyPath: "seq", autoIncrement: true },
    { name: STORES.meta, keyPath: "key" },
  ];
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(name, version);
    open.onupgradeneeded = () => {
      const db = open.result;
      for (const d of descriptors) {
        if (db.objectStoreNames.contains(d.name)) continue;
        const os = db.createObjectStore(d.name, {
          keyPath: d.keyPath,
          autoIncrement: !!d.autoIncrement,
        });
        for (const idx of d.indexes || []) {
          os.createIndex(idx.name, idx.keyPath, idx.options || {});
        }
      }
    };
    open.onsuccess = () => resolve(new IDB(open.result));
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(new Error("IndexedDB open blocked — close other tabs"));
  });
}

// Thin wrapper exposing the handful of operations SyncEngine needs. Every method
// runs in its own transaction, which is simplest and safe for our access sizes.
export class IDB {
  constructor(db) {
    this.db = db;
  }

  _tx(store, mode = "readonly") {
    return this.db.transaction(store, mode).objectStore(store);
  }

  get(store, key) {
    return REQ(this._tx(store).get(key));
  }

  getAll(store) {
    return REQ(this._tx(store).getAll());
  }

  put(store, value) {
    const os = this._tx(store, "readwrite");
    return REQ(os.put(value));
  }

  // Bulk put in a single transaction — used by pull() to write a merged snapshot.
  putMany(store, values) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, "readwrite");
      const os = tx.objectStore(store);
      for (const v of values) os.put(v);
      tx.oncomplete = () => resolve(values.length);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  delete(store, key) {
    return REQ(this._tx(store, "readwrite").delete(key));
  }

  clear(store) {
    return REQ(this._tx(store, "readwrite").clear());
  }

  // meta helpers — the key/value bag
  async metaGet(key, fallback = null) {
    const row = await this.get(STORES.meta, key);
    return row ? row.value : fallback;
  }

  metaSet(key, value) {
    return this.put(STORES.meta, { key, value });
  }
}

// Whether IndexedDB is usable in this context (private-mode Safari can throw).
export function idbAvailable() {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    return false;
  }
}
