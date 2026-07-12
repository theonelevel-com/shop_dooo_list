/**
 * Household admin — per-member visibility (shop worker copy).
 *
 * Mirrors dooo-api/src/access.ts, but member_rules lives in the shared `dooo`
 * auth DB, bound here as AUTH_DB (the shop list data is in DB). Default-open,
 * owner-exempt: only a signed-in MEMBER with an explicit rule row is filtered.
 *
 * shop has no category/type column, so `hidden_types` has nothing to bind to —
 * the enforceable levers are app_access (deny) and scope='own' (li.created_by).
 */

import type { AuthContext } from "./vendor/dooo-core/auth-server.js";

export type AppId = "pre" | "to" | "note" | "shop";

interface RuleRow { app_access: number; hidden_types: string | null; scope: string; }

export interface Visibility { denied: boolean; where: string; binds: unknown[]; }

const OPEN: Visibility = { denied: false, where: "", binds: [] };

export async function visibilityFor(
  authDb: D1Database, auth: AuthContext, app: AppId,
  cols: { type?: string; createdBy?: string },
): Promise<Visibility> {
  if (!auth.userId || auth.role !== "member") return OPEN;

  const rule = await authDb.prepare(
    "SELECT app_access, hidden_types, scope FROM member_rules WHERE household_id=? AND user_id=? AND app=?"
  ).bind(auth.householdId, auth.userId, app).first<RuleRow>();
  if (!rule) return OPEN;
  if (!rule.app_access) return { denied: true, where: "", binds: [] };

  const clauses: string[] = [];
  const binds: unknown[] = [];

  if (rule.scope === "own" && cols.createdBy) {
    clauses.push(`${cols.createdBy} = ?`);
    binds.push(auth.userId);
  }
  if (rule.hidden_types && cols.type) {
    let hidden: string[] = [];
    try { hidden = JSON.parse(rule.hidden_types); } catch { /* ignore */ }
    hidden = hidden.filter(Boolean);
    if (hidden.length) {
      clauses.push(`(${cols.type} IS NULL OR ${cols.type} NOT IN (${hidden.map(() => "?").join(",")}))`);
      binds.push(...hidden);
    }
  }

  return { denied: false, where: clauses.length ? " AND " + clauses.join(" AND ") : "", binds };
}
