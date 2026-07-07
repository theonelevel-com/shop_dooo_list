// auth-server.js — the ONE authenticate() shared by dooo-api, the shop worker,
// and dash.dooo's Pages Functions. All three bind the `dooo` D1 database (as DB
// or AUTH_DB) where the auth tables live.
//
// Resolution order for a request credential:
//   1. Session JWT (contains two dots; HEADERS ONLY — never query/body, so JWTs
//      stay out of URL logs) → signature + sessions-row revocation check.
//   2. api_tokens hash lookup (headers, ?token= query, or body token — Apple
//      Shortcuts keeps its query-param carrier).
//   3. Legacy env-var token compare (belt-and-braces during the Stage 4
//      migration window; pass legacyTokens: [] after cutover).
// Returns { householdId, userId, role, email, sessionId, authMethod } or null.

import { verifySessionJwt, sha256Hex, timingSafeEqual } from "./auth-shared.js";

function extractCandidates(request, bodyToken) {
  const fromHeader =
    request.headers.get("X-PreDo-Token") ||
    (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "") ||
    "";
  let fromQuery = "";
  try {
    fromQuery = new URL(request.url).searchParams.get("token") || "";
  } catch {
    /* relative URLs in tests */
  }
  return { fromHeader, fromQuery, fromBody: String(bodyToken || "") };
}

const looksLikeJwt = (s) => typeof s === "string" && s.split(".").length === 3;

export async function authenticate(request, opts) {
  const { db, secrets, legacyTokens = [], bodyToken = "", ctx = null } = opts;
  const { fromHeader, fromQuery, fromBody } = extractCandidates(request, bodyToken);

  // 1) Session JWT — header carrier only.
  if (looksLikeJwt(fromHeader)) {
    const claims = await verifySessionJwt(fromHeader, secrets);
    if (!claims || !claims.jti || !claims.hh) return null;
    const row = await db
      .prepare("SELECT revoked_at, expires_at FROM sessions WHERE id = ?")
      .bind(claims.jti)
      .first();
    if (!row || row.revoked_at) return null;
    if (row.expires_at && row.expires_at <= nowSql()) return null;
    touch(
      db,
      ctx,
      "UPDATE sessions SET last_seen_at = datetime('now') WHERE id = ? AND last_seen_at < datetime('now','-1 hour')",
      [claims.jti]
    );
    return {
      householdId: claims.hh,
      userId: claims.sub || null,
      role: claims.role || "member",
      email: claims.em || null,
      sessionId: claims.jti,
      authMethod: "session",
    };
  }

  // 2) api_tokens — any carrier.
  for (const candidate of [fromHeader, fromQuery, fromBody]) {
    if (!candidate || looksLikeJwt(candidate)) continue;
    const hash = await sha256Hex(candidate);
    const row = await db
      .prepare(
        "SELECT id, household_id, user_id FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL"
      )
      .bind(hash)
      .first();
    if (row) {
      touch(
        db,
        ctx,
        "UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ? AND (last_used_at IS NULL OR last_used_at < datetime('now','-1 hour'))",
        [row.id]
      );
      return {
        householdId: row.household_id,
        userId: row.user_id || null,
        role: null,
        email: null,
        sessionId: null,
        authMethod: "api_token",
      };
    }
  }

  // 3) Legacy env-var tokens (migration window only).
  for (const legacy of legacyTokens) {
    if (!legacy || !legacy.token) continue;
    for (const candidate of [fromHeader, fromQuery, fromBody]) {
      if (candidate && timingSafeEqual(candidate, legacy.token)) {
        return {
          householdId: legacy.householdId || "default",
          userId: null,
          role: null,
          email: null,
          sessionId: null,
          authMethod: "legacy",
        };
      }
    }
  }

  return null;
}

// SQLite datetime('now') format for lexicographic comparison in JS.
function nowSql() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

// Fire-and-forget bookkeeping writes — never block or fail the request.
function touch(db, ctx, sql, params) {
  const p = db
    .prepare(sql)
    .bind(...params)
    .run()
    .catch(() => {});
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p);
}
