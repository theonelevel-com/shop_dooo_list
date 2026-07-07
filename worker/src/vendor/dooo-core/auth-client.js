// auth-client.js — browser-side session plumbing for pre/to/shop (and dash's
// sign-in JS). Sessions persist in the IDB `meta` store — readable by both the
// main window and the service worker, and NOT subject to the iframe
// localStorage partitioning that bit us on iOS (embedded copies get their
// session from the dash shell over the bridge instead and keep it in memory).

import { decodeJwtClaims } from "./auth-shared.js";

const SESSION_KEY = "auth.session";

// idb is a dooo-core IDB instance (idb.js). Session shape:
//   { jwt, user: {id,email,role}, household: {id,name}, savedAt }
export function createSessionStore(idb) {
  return {
    async load() {
      try {
        return (await idb.metaGet(SESSION_KEY)) || null;
      } catch {
        return null;
      }
    },
    async save(session) {
      await idb.metaSet(SESSION_KEY, { ...session, savedAt: new Date().toISOString() });
      return session;
    },
    async clear() {
      await idb.metaSet(SESSION_KEY, null);
    },
  };
}

async function post(apiBase, path, body, jwt) {
  const headers = { "Content-Type": "application/json" };
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
  const resp = await fetch(`${String(apiBase).replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body || {}),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.ok === false) {
    const err = new Error(data.error || `auth request failed (${resp.status})`);
    err.status = resp.status;
    throw err;
  }
  return data;
}

// Ask the server to email a magic link (+ 6-digit code) to `email`.
// `redirect` must be on the server's allowlist; use the app's own origin so
// the link lands back in this app. Always resolves ok (no user enumeration).
export async function requestMagicLink(apiBase, { email, redirect }) {
  return post(apiBase, "/auth/request-link", { email, redirect });
}

// Exchange a link token ({token}) or an email+code pair for a session.
// Returns { jwt, user, household }.
export async function verifyMagicLink(apiBase, { token, email, code }) {
  return post(apiBase, "/auth/verify", token ? { token } : { email, code });
}

// Sliding renewal: if the JWT is older than maxAgeDays, swap it for a fresh
// one (same session id server-side). Returns the updated session, or the
// original if renewal wasn't needed / failed (stale-but-valid JWTs keep
// working until their own exp — renewal failure is never fatal).
export async function renewIfStale(apiBase, session, { maxAgeDays = 7 } = {}) {
  if (!session || !session.jwt) return session;
  const claims = decodeJwtClaims(session.jwt);
  const ageDays = claims && claims.iat ? (Date.now() / 1000 - claims.iat) / 86400 : Infinity;
  if (ageDays < maxAgeDays) return session;
  try {
    const data = await post(apiBase, "/auth/renew", {}, session.jwt);
    return { ...session, jwt: data.jwt };
  } catch {
    return session;
  }
}
