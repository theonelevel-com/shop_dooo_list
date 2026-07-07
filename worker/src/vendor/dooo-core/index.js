// @dooo/core — shared offline-first sync client for the dooolist.com suite.
// Dependency-free browser ES modules. See README.md for adoption steps.

export { SyncEngine } from "./sync-engine.js";
export { openDB, IDB, STORES, idbAvailable } from "./idb.js";
export { Outbox } from "./queue.js";
export { normalizeText, contentHash, contentHashSync, SeenHashes } from "./dedup.js";
export { createTodoTransport, createInboxTransport } from "./transports.js";
export { sha256Hex, randomToken, randomCode, timingSafeEqual, signSessionJwt, verifySessionJwt, decodeJwtClaims } from "./auth-shared.js";
export { authenticate } from "./auth-server.js";
export { createSessionStore, requestMagicLink, verifyMagicLink, renewIfStale } from "./auth-client.js";
export { drainLegacyOutbox } from "./migrate-legacy.js";
