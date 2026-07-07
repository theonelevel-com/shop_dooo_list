// Type declarations for auth-server.js (vendored into TS workers).

export interface AuthContext {
  householdId: string;
  userId: string | null;
  role: "owner" | "member" | null;
  email: string | null;
  sessionId: string | null;
  authMethod: "session" | "api_token" | "legacy";
}

export interface AuthenticateOptions {
  /** D1 database holding the auth tables (the `dooo` DB — binding DB or AUTH_DB). */
  db: D1Database;
  /** [SESSION_SECRET, SESSION_SECRET_PREV?] — rotation-aware verify. */
  secrets: Array<string | undefined>;
  /** Env-var fallback tokens during the migration window; [] after cutover. */
  legacyTokens?: Array<{ token: string; householdId?: string }>;
  /** GAS-compat POST body token, if the route parsed a body. */
  bodyToken?: string;
  /** ExecutionContext for fire-and-forget last_seen/last_used bumps. */
  ctx?: { waitUntil(p: Promise<unknown>): void } | null;
}

export function authenticate(
  request: Request,
  opts: AuthenticateOptions
): Promise<AuthContext | null>;
