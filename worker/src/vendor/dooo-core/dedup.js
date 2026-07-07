// dedup.js — durable content-based dedup for captured text.
//
// Re-homes the Stage 0 fix (originally shipped to the GAS backend, commit
// 9d2d748) that replaced the fragile 60-second time-window dedup. A Shortcut-
// queued capture can arrive hours or days late (phone offline / data depleted),
// so time-window matching misses it. Instead we hash NORMALISED text and reject
// any capture whose hash we've already seen, regardless of age.
//
// Normalisation must match on both client and server so a capture deduped on one
// side is deduped on the other. Keep this function byte-stable.

// Lowercase, strip punctuation/symbols, collapse whitespace, trim. Unicode-aware
// so "Buy milk!" == "buy  milk" == "BUY MILK." — same intent, one hash.
export function normalizeText(input) {
  return String(input == null ? "" : input)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // drop punctuation & symbols
    .replace(/\s+/gu, " ")
    .trim();
}

// SHA-256 hex of the normalised text. Requires crypto.subtle (secure context —
// all suite apps are https). Falls back to a sync FNV-1a hash where subtle is
// unavailable (e.g. some worker/test contexts) so dedup never hard-fails.
export async function contentHash(input) {
  const norm = normalizeText(input);
  try {
    const bytes = new TextEncoder().encode(norm);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return hex(new Uint8Array(digest));
  } catch {
    return "fnv1a_" + fnv1a(norm);
  }
}

// Synchronous, non-cryptographic fallback. Good enough for dedup keying; not for
// anything security-sensitive.
export function contentHashSync(input) {
  return "fnv1a_" + fnv1a(normalizeText(input));
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function hex(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, "0");
  return s;
}

// A small persistent set of seen hashes, backed by the meta store. Used by
// SyncEngine when an app opts into capture-style dedup (pre-dooo inbox). Bounded
// to avoid unbounded growth: keeps the most recent `max` hashes (insertion order).
export class SeenHashes {
  constructor(idb, { key = "dedupe:hashes", max = 5000 } = {}) {
    this.idb = idb;
    this.key = key;
    this.max = max;
    this._set = null; // Map<hash, insertionIndex> loaded lazily
  }

  async _load() {
    if (this._set) return;
    const arr = (await this.idb.metaGet(this.key, [])) || [];
    this._set = new Map(arr.map((h, i) => [h, i]));
  }

  async has(hash) {
    await this._load();
    return this._set.has(hash);
  }

  async add(hash) {
    await this._load();
    if (this._set.has(hash)) return false;
    this._set.set(hash, this._set.size);
    // Trim oldest if over cap.
    if (this._set.size > this.max) {
      const excess = this._set.size - this.max;
      const keys = [...this._set.keys()].slice(excess);
      this._set = new Map(keys.map((h, i) => [h, i]));
    }
    await this.idb.metaSet(this.key, [...this._set.keys()]);
    return true;
  }
}
