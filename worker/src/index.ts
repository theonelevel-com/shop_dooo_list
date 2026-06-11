/**
 * Shop Wise API — Cloudflare Worker
 * Routes documented in worker/README.md.
 */

import { resolveItem } from "./resolver";
import { checkPrices } from "./price-checker";

export interface Env {
  DB: D1Database;
  SHOPWISE_AUTH_TOKEN: string;
  ALLOWED_ORIGINS: string;
  // LLM provider secrets — only set if you want the resolver / price-check
  // agent on. The router reads whichever applies based on RESOLVER_MODEL.
  ANTHROPIC_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  RESOLVER_AI_MODE?: string;     // "on" | "off" (default "off")
  RESOLVER_MODEL?: string;        // default "deepseek-chat"
  PRICE_CHECK_MODE?: string;      // "on" | "off"
  PRICE_REFRESH_DAYS?: string;    // e.g. "30"
}

type Json = Record<string, unknown> | unknown[];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    try {
      return await route(request, env, url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonResp({ ok: false, error: msg }, env, 500);
    }
  },

  // Cron handler. Cloudflare invokes this on the schedule(s) configured in
  // wrangler.toml [triggers].crons. We use it to drive the price-checking
  // agent. It no-ops when PRICE_CHECK_MODE != "on".
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      try {
        const r = await checkPrices(env);
        console.log("price-check tick:", JSON.stringify(r));
      } catch (e) {
        console.error("price-check tick failed:", e);
      }
    })());
  }
};

// ─────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────
async function route(req: Request, env: Env, url: URL): Promise<Response> {
  const p = url.pathname;
  const m = req.method;

  // Truly-open routes (no auth):
  //   • health checks — useful for monitoring + the user knowing the
  //     Worker is alive
  //   • the from-pre-do GET redirect — Pre-Do stores this URL as the
  //     action's "Open" link, so a browser visit must succeed without
  //     a token (we 302 the user into the live app, where the app's
  //     own token then takes over)
  if (p === "/" || p === "/api" || p === "/api/health") {
    return jsonResp({ ok: true, service: "shop-dooo-api", version: "0.1.0" }, env);
  }
  if (m === "GET" && (p === "/api/from-pre-do" || p === "/api/from-pre-dooo")) {
    return Response.redirect("https://shop-wise.pages.dev/?from=predo", 302);
  }

  // Everything else — including reads — now requires the bearer token.
  // The Pre-Do POST has its own auth dance (token may arrive in the body
  // rather than the header), so route to it before the generic check.
  if (m === "POST" && (p === "/api/from-pre-do" || p === "/api/from-pre-dooo")) {
    const cloned = req.clone();
    const body = await readJson(cloned).catch(() => ({}));
    const bodyToken = (body && typeof body === "object" && "token" in body) ? String(body.token) : "";
    const headerOk = checkAuth(req, env) === null;
    if (!headerOk && bodyToken !== env.SHOPWISE_AUTH_TOKEN) {
      return jsonResp({ ok: false, error: "Unauthorized" }, env, 401);
    }
    return fromPreDo(req, env);
  }
  const authError = checkAuth(req, env);
  if (authError) return authError;

  // ─── Read routes (token required) ───
  if (m === "GET" && p === "/api/retailers")        return getRetailers(env);
  if (m === "GET" && p === "/api/aisles")           return getAisles(env, url);
  if (m === "GET" && p === "/api/catalog")          return getCatalog(env, url);
  if (m === "GET" && p === "/api/list")             return getList(env, url);
  if (m === "GET" && p === "/api/list/version")     return getListVersion(env);
  if (m === "GET" && p === "/api/products/lookup")  return lookupProduct(env, url);

  // List ops
  if (m === "POST" && p === "/api/list/add")              return listAdd(req, env);
  if (m === "POST" && p === "/api/list/check")            return listCheck(req, env);
  if (m === "POST" && p === "/api/list/assign")           return listAssign(req, env);
  if (m === "POST" && p === "/api/list/update")           return listUpdate(req, env);
  if (m === "POST" && p === "/api/list/delete")           return listDelete(req, env);
  if (m === "POST" && p === "/api/list/external-status")  return listExternalStatus(req, env);

  // Admin: review queue (auto-created products awaiting human approval)
  if (m === "GET"  && p === "/api/admin/review/pending") return getPendingReview(env);
  if (m === "POST" && p === "/api/admin/review/approve") return approveProduct(req, env);
  if (m === "POST" && p === "/api/admin/review/reject")  return rejectProduct(req, env);

  // Admin CRUD
  const adminMatch = p.match(/^\/api\/admin\/(retailers|products|aisles|locations)$/);
  if (adminMatch) {
    const resource = adminMatch[1];
    if (m === "POST")    return adminCreate(req, env, resource);
    if (m === "PATCH")   return adminUpdate(req, env, resource);
    if (m === "DELETE")  return adminDelete(req, env, resource);
  }

  return jsonResp({ ok: false, error: "Not found", path: p }, env, 404);
}

// ─────────────────────────────────────────────────────────────────────────
// Auth + CORS
// ─────────────────────────────────────────────────────────────────────────
function checkAuth(req: Request, env: Env): Response | null {
  const h = req.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1].trim() : "";
  if (!env.SHOPWISE_AUTH_TOKEN) {
    return jsonResp({ ok: false, error: "Server token not configured" }, env, 500);
  }
  if (token !== env.SHOPWISE_AUTH_TOKEN) {
    return jsonResp({ ok: false, error: "Unauthorized" }, env, 401);
  }
  return null;
}

function corsHeaders(env: Env): HeadersInit {
  const allow = env.ALLOWED_ORIGINS && env.ALLOWED_ORIGINS.length > 0 ? env.ALLOWED_ORIGINS : "*";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResp(body: Json, env: Env, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(env),
    },
  });
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try { return (await req.json()) as Record<string, unknown>; }
  catch { return {}; }
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────
function uuid(): string {
  return crypto.randomUUID();
}
function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

/**
 * Normalise a "size / pack" string: lowercase, any non-alphanumeric (except
 * period for decimals) becomes a space, multi-space collapsed, trimmed.
 *   "5 Pack"      → "5 pack"
 *   "1.5L"        → "1.5l"
 *   "6 x 1L"      → "6 x 1l"
 *   "3-Pack"      → "3 pack"
 *   "20m x 450mm" → "20m x 450mm"
 *   ""            → null
 */
function normalizeSize(s: string | null | undefined): string | null {
  if (!s) return null;
  const out = String(s)
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return out || null;
}

/**
 * Smart Title Case for arriving product names.
 *  - "tastic rice"  → "Tastic Rice"
 *  - "TASTIC RICE"  → "Tastic Rice"
 *  - "fatti's"      → "Fatti's"
 *  - "coca-cola"    → "Coca-Cola"
 *  - "NikNaks"      → "NikNaks"  (already mixed-case → trust the user)
 *  - "CR2032 batteries" → "CR2032 Batteries" (mixed → trust)
 */
function smartTitleCase(s: string): string {
  if (!s) return s;
  const trimmed = s.trim();
  if (!trimmed) return trimmed;
  const allLower = trimmed === trimmed.toLowerCase();
  const allUpper = trimmed === trimmed.toUpperCase();
  if (!allLower && !allUpper) return trimmed; // mixed case → preserve
  // Capitalise the first letter after a start, space, hyphen, or apostrophe.
  return trimmed
    .toLowerCase()
    .replace(/(^|[\s\-'])(\p{L})/gu, (_m, sep, ch) => sep + ch.toUpperCase());
}

// ─────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────
async function getRetailers(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT id, name, color, kind, online_url_template, position, is_default
     FROM retailers ORDER BY position, name`
  ).all();
  return jsonResp({ ok: true, retailers: results }, env);
}

async function getAisles(env: Env, url: URL): Promise<Response> {
  const retailer = url.searchParams.get("retailer");
  let q = `SELECT id, retailer_id, name, sub, position, kind, side, map_x, map_y, map_w, map_h FROM aisles`;
  const binds: unknown[] = [];
  if (retailer) { q += ` WHERE retailer_id = ?`; binds.push(retailer); }
  q += ` ORDER BY retailer_id, position`;
  const { results } = await env.DB.prepare(q).bind(...binds).all();
  return jsonResp({ ok: true, aisles: results }, env);
}

async function getCatalog(env: Env, url: URL): Promise<Response> {
  const retailer = url.searchParams.get("retailer");
  let q = `
    SELECT p.id AS product_id, p.name, p.variant, p.brand, p.notes,
           p.default_brand, p.default_size, p.default_quantity, p.default_notes,
           p.default_tags, p.default_retailer_id, p.default_price, p.default_price_updated_at,
           l.id AS location_id, l.retailer_id, l.aisle_id,
           l.indicative_price, l.indicative_price_updated_at, l.is_primary
    FROM products p
    LEFT JOIN product_locations l ON l.product_id = p.id
  `;
  const binds: unknown[] = [];
  if (retailer) { q += ` WHERE l.retailer_id = ?`; binds.push(retailer); }
  q += ` ORDER BY p.name`;
  const { results } = await env.DB.prepare(q).bind(...binds).all();
  return jsonResp({ ok: true, catalog: results }, env);
}

/**
 * Tiny endpoint clients hit on a poll. Returns a "version" that changes
 * whenever the list has changed (new row, edit, delete). When unchanged,
 * the client skips the full /api/list fetch. ~50-byte responses.
 *
 * The version combines MAX(updated_at) (catches inserts/updates) and
 * COUNT(*) (catches deletes, which don't bump any row's updated_at).
 */
async function getListVersion(env: Env): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT MAX(updated_at) AS max_updated, COUNT(*) AS n FROM list_items`
  ).first<{ max_updated: string | null; n: number }>();
  const v = `${row?.max_updated || "0"}/${row?.n ?? 0}`;
  return jsonResp({ ok: true, v }, env);
}

async function getList(env: Env, url: URL): Promise<Response> {
  const sourceActionId = url.searchParams.get("source_action_id");
  const fulfilmentMode = url.searchParams.get("fulfilment_mode");
  let q = `
    SELECT li.id, li.name, li.product_id, li.retailer_id, li.aisle_id,
           li.quantity, li.variant, li.brand, li.size, li.tags,
           li.checked, li.fulfilment_mode, li.online_order_link, li.external_status,
           li.source, li.source_action_id, li.source_inbox_id,
           li.created_at, li.updated_at,
           r.name AS retailer_name, r.kind AS retailer_kind, r.color AS retailer_color,
           r.online_url_template,
           a.name AS aisle_name, a.sub AS aisle_sub, a.position AS aisle_position,
           pl.indicative_price, pl.indicative_price_updated_at,
           pr.notes AS product_notes
    FROM list_items li
    LEFT JOIN products pr ON pr.id = li.product_id
    LEFT JOIN retailers r ON r.id = li.retailer_id
    LEFT JOIN aisles a ON a.id = li.aisle_id
    LEFT JOIN product_locations pl
           ON pl.product_id = li.product_id AND pl.retailer_id = li.retailer_id
    WHERE 1=1
  `;
  const binds: unknown[] = [];
  if (sourceActionId) { q += ` AND li.source_action_id = ?`; binds.push(sourceActionId); }
  if (fulfilmentMode) { q += ` AND li.fulfilment_mode = ?`; binds.push(fulfilmentMode); }
  q += ` ORDER BY li.created_at`;
  const { results } = await env.DB.prepare(q).bind(...binds).all();
  return jsonResp({ ok: true, items: results }, env);
}

async function lookupProduct(env: Env, url: URL): Promise<Response> {
  const name = (url.searchParams.get("name") || "").trim();
  if (!name) return jsonResp({ ok: false, error: "name required" }, env, 400);

  // Exact case-insensitive match first
  let row = await env.DB.prepare(
    `SELECT p.id AS product_id, p.name,
            l.retailer_id, l.aisle_id, l.indicative_price
     FROM products p
     LEFT JOIN product_locations l ON l.product_id = p.id
     WHERE LOWER(p.name) = LOWER(?)
     ORDER BY l.is_primary DESC, l.retailer_id
     LIMIT 1`
  ).bind(name).first();

  if (!row) {
    row = await env.DB.prepare(
      `SELECT p.id AS product_id, p.name,
              l.retailer_id, l.aisle_id, l.indicative_price
       FROM products p
       LEFT JOIN product_locations l ON l.product_id = p.id
       WHERE LOWER(p.name) LIKE LOWER(?) || '%'
       ORDER BY l.is_primary DESC, p.name
       LIMIT 1`
    ).bind(name).first();
  }

  if (!row) return jsonResp({ ok: false, found: false }, env, 404);
  return jsonResp({ ok: true, found: true, ...row }, env);
}

// ─────────────────────────────────────────────────────────────────────────
// List ops
// ─────────────────────────────────────────────────────────────────────────
/**
 * Add an item to the list, merging by (name + retailer + brand + size) when
 * an unchecked match exists — in that case it increments quantity by addQty.
 * Used by both manual /api/list/add and Pre-Do ingestion.
 */
async function addItemToList(env: Env, opts: {
  name: string;
  productId?: string;            // if set, skip name-based resolver and use this product directly
  quantity?: number;
  retailerId?: string | null;
  aisleId?: string | null;
  variant?: string | null;
  brand?: string | null;
  size?: string | null;
  notes?: string | null;
  tags?: string | null;
  fulfilmentMode?: "in_store" | "online";
  onlineOrderLink?: string | null;
  source?: "manual" | "pre-do";
  sourceActionId?: string | null;
  sourceInboxId?: string | null;
  retailerOverride?: boolean;  // if true, don't fall back to product's default retailer
}): Promise<{ id: string; merged: boolean; quantity: number }> {
  // When the caller picked an exact product (e.g. autocomplete on the list
  // input), look that up directly and skip the name/AI resolver. Otherwise
  // run the strict-first, AI-fallback resolver.
  let resolved;
  if (opts.productId) {
    const row = await env.DB.prepare(
      `SELECT p.id AS product_id, p.name AS canonical_name, p.variant,
              p.default_brand, p.default_size, p.default_tags, p.default_retailer_id,
              l.retailer_id AS loc_retailer_id, l.aisle_id AS loc_aisle_id
       FROM products p
       LEFT JOIN product_locations l ON l.product_id = p.id AND l.is_primary = 1
       WHERE p.id = ?
       LIMIT 1`
    ).bind(opts.productId).first<any>();
    if (row) {
      resolved = {
        name: row.canonical_name,
        product_id: row.product_id,
        retailer_id: row.default_retailer_id || row.loc_retailer_id || null,
        aisle_id: row.loc_aisle_id ?? null,
        variant: row.variant ?? null,
        brand:   row.default_brand ?? null,
        size:    row.default_size  ?? null,
        tags:    row.default_tags  ?? null,
      } as any;
    }
  }
  if (!resolved) resolved = await resolveItem(env, opts.name);
  const name = resolved.name;
  const addQty = Math.max(1, opts.quantity || resolved.quantity || 1);
  const now = nowIso();

  // All product-side resolution already happened in resolveItem(). Caller
  // overrides still win; resolver-supplied defaults fill blanks.
  const canonical = resolved.name;
  const productId = resolved.product_id ?? null;

  const retailerId = opts.retailerId !== undefined && opts.retailerId !== null
    ? opts.retailerId
    : (resolved.retailer_id ?? null);

  let aisleId: string | null = opts.aisleId !== undefined && opts.aisleId !== null
    ? opts.aisleId
    : (resolved.aisle_id ?? null);
  // If we ended up with a retailer but no aisle for in-store, try to pick one
  // from product_locations (covers the case where resolver returned a
  // retailer override but didn't know the aisle for that retailer).
  if (productId && retailerId && !aisleId && (opts.fulfilmentMode || "in_store") === "in_store") {
    const loc = await env.DB.prepare(
      `SELECT aisle_id FROM product_locations WHERE product_id = ? AND retailer_id = ?`
    ).bind(productId, retailerId).first<{ aisle_id: string | null }>();
    if (loc?.aisle_id) aisleId = loc.aisle_id;
  }
  if (opts.fulfilmentMode === "online") aisleId = null;

  const brand   = opts.brand   !== undefined ? opts.brand   : (resolved.brand   ?? null);
  const size    = normalizeSize(opts.size !== undefined ? opts.size : (resolved.size ?? null));
  const tags    = opts.tags    !== undefined ? opts.tags    : (resolved.tags    ?? null);
  const variant = opts.variant !== undefined ? opts.variant : (resolved.variant ?? null);

  const effectiveQty = Math.max(1, opts.quantity || resolved.quantity || addQty);
  const fulfil    = opts.fulfilmentMode || "in_store";
  const orderLink = opts.onlineOrderLink || null;
  const source    = opts.source || "manual";

  // Increment-on-duplicate. Variant joins the merge key so e.g. "Long Life
  // Milk" and "Full Cream Milk" stay as separate rows.
  const existing = await env.DB.prepare(
    `SELECT id, quantity FROM list_items
     WHERE LOWER(name) = LOWER(?)
       AND COALESCE(retailer_id,'') = COALESCE(?, '')
       AND COALESCE(brand,'')       = COALESCE(?, '')
       AND COALESCE(size,'')        = COALESCE(?, '')
       AND COALESCE(variant,'')     = COALESCE(?, '')
       AND checked = 0
     LIMIT 1`
  ).bind(canonical, retailerId, brand, size, variant).first<{ id: string; quantity: number }>();

  if (existing) {
    const newQty = (existing.quantity || 1) + addQty;
    await env.DB.prepare(
      `UPDATE list_items SET quantity = ?, updated_at = ? WHERE id = ?`
    ).bind(newQty, now, existing.id).run();
    return { id: existing.id, merged: true, quantity: newQty };
  }

  const id = uuid();
  await env.DB.prepare(
    `INSERT INTO list_items
       (id, name, product_id, retailer_id, aisle_id, quantity, variant, brand, size, tags,
        fulfilment_mode, online_order_link, source, source_action_id, source_inbox_id,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, canonical, productId, retailerId, aisleId, effectiveQty, variant, brand, size, tags,
         fulfil, orderLink, source, opts.sourceActionId || null, opts.sourceInboxId || null,
         now, now).run();

  return { id, merged: false, quantity: effectiveQty };
}

async function listAdd(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req);
  const name = (body.name as string || "").trim();
  if (!name) return jsonResp({ ok: false, error: "name required" }, env, 400);
  const result = await addItemToList(env, {
    name,
    productId: body.product_id as string | undefined,
    quantity: body.quantity as number | undefined,
    retailerId: body.retailerId as string | undefined,
    aisleId: body.aisleId as string | undefined,
    variant: body.variant as string | undefined,
    brand: body.brand as string | undefined,
    size: body.size as string | undefined,
    tags: body.tags as string | undefined,
    fulfilmentMode: (body.fulfilmentMode as "in_store" | "online" | undefined),
    onlineOrderLink: body.onlineOrderLink as string | undefined,
  });
  return jsonResp({ ok: true, ...result }, env, result.merged ? 200 : 201);
}

async function listCheck(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req);
  const id = body.id as string;
  const checked = body.checked ? 1 : 0;
  if (!id) return jsonResp({ ok: false, error: "id required" }, env, 400);
  await env.DB.prepare(
    `UPDATE list_items SET checked = ?, updated_at = ? WHERE id = ?`
  ).bind(checked, nowIso(), id).run();
  return jsonResp({ ok: true }, env);
}

async function listAssign(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req);
  const id = body.id as string;
  if (!id) return jsonResp({ ok: false, error: "id required" }, env, 400);
  const retailerId = (body.retailerId as string) ?? null;
  const aisleId    = (body.aisleId as string) ?? null;
  await env.DB.prepare(
    `UPDATE list_items SET retailer_id = ?, aisle_id = ?, updated_at = ? WHERE id = ?`
  ).bind(retailerId, aisleId, nowIso(), id).run();
  return jsonResp({ ok: true }, env);
}

async function listUpdate(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req);
  const id = body.id as string;
  if (!id) return jsonResp({ ok: false, error: "id required" }, env, 400);

  // Whitelist fields. Notes is intentionally absent — it now lives on the
  // product (products.notes). The frontend edits product notes via the
  // /api/admin/products endpoint when the user changes notes from the
  // per-item dialog.
  const allowed = ["name", "checked", "retailer_id", "aisle_id", "quantity", "variant", "brand", "size", "tags",
                   "fulfilment_mode", "online_order_link", "external_status"];
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const k of allowed) {
    if (k in body) {
      sets.push(`${k} = ?`);
      let v = body[k];
      if (k === "checked") v = v ? 1 : 0;
      if (k === "name" && typeof v === "string") v = smartTitleCase(v);
      if (k === "size" && typeof v === "string") v = normalizeSize(v);
      binds.push(v);
    }
  }
  if (!sets.length) return jsonResp({ ok: false, error: "no fields to update" }, env, 400);
  sets.push(`updated_at = ?`);
  binds.push(nowIso(), id);
  await env.DB.prepare(`UPDATE list_items SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  return jsonResp({ ok: true }, env);
}

async function listDelete(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req);
  const id = body.id as string;
  if (!id) return jsonResp({ ok: false, error: "id required" }, env, 400);
  await env.DB.prepare(`DELETE FROM list_items WHERE id = ?`).bind(id).run();
  return jsonResp({ ok: true }, env);
}

async function listExternalStatus(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req);
  const sourceActionId = body.source_action_id as string;
  const status = body.status as string;
  const itemName = body.item_name as string | undefined;
  if (!sourceActionId || !status) {
    return jsonResp({ ok: false, error: "source_action_id and status required" }, env, 400);
  }
  const isComplete = ["delivered", "completed", "bought"].includes(status);
  let q = `UPDATE list_items SET external_status = ?, ${isComplete ? "checked = 1, " : ""} updated_at = ? WHERE source_action_id = ?`;
  const binds: unknown[] = [status, nowIso(), sourceActionId];
  if (itemName) { q += ` AND LOWER(name) = LOWER(?)`; binds.push(itemName); }
  const result = await env.DB.prepare(q).bind(...binds).run();
  return jsonResp({ ok: true, updated: result.meta?.changes ?? 0 }, env);
}

// ─────────────────────────────────────────────────────────────────────────
// Pre-Do ingest
// ─────────────────────────────────────────────────────────────────────────
async function fromPreDo(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req);
  const inboxId  = body.inboxId  as string;
  const actionId = body.actionId as string;
  const title    = (body.title as string) || "";
  const fulfilmentMode = ((body.fulfilmentMode as string) || "in_store") === "online" ? "online" : "in_store";
  const onlineOrderLink = (body.onlineOrderLink as string) || null;
  let overrideRetailer = (body.retailerId as string) || null;

  // If Pre-Do didn't specify a retailer, try to infer one from the action title.
  // E.g. title "Buy at Checkers" → checkers. First case-insensitive name or
  // slug match wins.
  if (!overrideRetailer && title) {
    const titleLower = title.toLowerCase();
    const retailers = await env.DB.prepare(`SELECT id, name FROM retailers WHERE id != 'other'`).all<{ id: string; name: string }>();
    for (const r of (retailers.results || [])) {
      const nameLower = r.name.toLowerCase();
      if (titleLower.includes(nameLower) || titleLower.includes(r.id.toLowerCase())) {
        overrideRetailer = r.id;
        break;
      }
    }
  }

  let rawItems: string[];
  if (Array.isArray(body.items) && body.items.length > 0) {
    rawItems = (body.items as unknown[]).map(x => String(x)).filter(Boolean);
  } else if (title) {
    rawItems = [title];
  } else {
    return jsonResp({ ok: false, error: "no items in payload" }, env, 400);
  }

  // Pre-merge duplicates within the payload itself
  const tally = new Map<string, number>();
  for (const r of rawItems) {
    const k = r.trim();
    if (!k) continue;
    tally.set(k, (tally.get(k) || 0) + 1);
  }

  const insertedIds: string[] = [];
  for (const [name, qty] of tally) {
    const result = await addItemToList(env, {
      name,
      quantity: qty,
      retailerId: overrideRetailer || undefined,  // falls back to "other" below if no product match
      fulfilmentMode,
      onlineOrderLink,
      source: "pre-do",
      sourceActionId: actionId,
      sourceInboxId: inboxId,
    });
    // Ensure no-match items land under "other" rather than NULL retailer
    if (!result.merged) {
      const it = await env.DB.prepare(
        `SELECT retailer_id FROM list_items WHERE id = ?`
      ).bind(result.id).first<{ retailer_id: string | null }>();
      if (!it?.retailer_id) {
        await env.DB.prepare(
          `UPDATE list_items SET retailer_id = 'other', updated_at = ? WHERE id = ?`
        ).bind(nowIso(), result.id).run();
      }
    }
    insertedIds.push(result.id);
  }

  return jsonResp({ ok: true, inserted: insertedIds.length, ids: insertedIds }, env, 201);
}

// ─────────────────────────────────────────────────────────────────────────
// Admin CRUD
// ─────────────────────────────────────────────────────────────────────────
const ADMIN_SCHEMA: Record<string, { table: string; fields: string[]; defaultIdPrefix?: string }> = {
  retailers: {
    table: "retailers",
    fields: ["id", "name", "color", "kind", "online_url_template", "position", "is_default"],
  },
  products: {
    table: "products",
    fields: ["id", "name", "variant", "brand", "notes",
             "default_brand", "default_size", "default_quantity", "default_notes",
             "default_tags", "default_retailer_id", "default_price", "default_price_updated_at"],
    defaultIdPrefix: "prod-",
  },
  aisles: {
    table: "aisles",
    fields: ["id", "retailer_id", "name", "sub", "position", "kind", "side", "map_x", "map_y", "map_w", "map_h"],
  },
  locations: {
    table: "product_locations",
    fields: ["id", "product_id", "retailer_id", "aisle_id",
             "indicative_price", "indicative_price_updated_at", "is_primary"],
    defaultIdPrefix: "loc-",
  },
};

async function adminCreate(req: Request, env: Env, resource: string): Promise<Response> {
  const def = ADMIN_SCHEMA[resource];
  if (!def) return jsonResp({ ok: false, error: "Unknown resource" }, env, 400);
  const body = await readJson(req);

  if (!body.id) body.id = def.defaultIdPrefix ? `${def.defaultIdPrefix}${uuid()}` : uuid();

  // Auto-stamp price timestamps when the price field is supplied; null the
  // timestamp out when the price itself is cleared.
  if (resource === "products" && "default_price" in body && !("default_price_updated_at" in body)) {
    body.default_price_updated_at = body.default_price == null ? null : nowIso();
  }
  if (resource === "locations" && "indicative_price" in body && !("indicative_price_updated_at" in body)) {
    body.indicative_price_updated_at = body.indicative_price == null ? null : nowIso();
  }
  // Size normalisation on products: silently coerce to lowercase + clean
  // spacing. No error if the user typed mixed case.
  if (resource === "products" && "default_size" in body) {
    body.default_size = normalizeSize(body.default_size as string | null);
  }

  // Locations have a UNIQUE (product_id, retailer_id) constraint. If a row
  // already exists for the pair, update it in place instead of throwing
  // "UNIQUE constraint failed". This also lets the matrix-table UI use a
  // single "save" path for both new and existing cells.
  if (resource === "locations") {
    const existing = await env.DB.prepare(
      `SELECT id FROM product_locations WHERE product_id = ? AND retailer_id = ?`
    ).bind(body.product_id, body.retailer_id).first<{ id: string }>();
    if (existing) {
      // Fold into the update path so we don't duplicate the SET logic
      body.id = existing.id;
      return await applyAdminUpdate(env, def, resource, body);
    }
  }

  const cols: string[] = [];
  const placeholders: string[] = [];
  const binds: unknown[] = [];
  for (const f of def.fields) {
    if (f in body) {
      cols.push(f);
      placeholders.push("?");
      binds.push(body[f]);
    }
  }
  if (cols.includes("updated_at") === false && resource !== "aisles") {
    cols.push("updated_at");
    placeholders.push("?");
    binds.push(nowIso());
  }

  await env.DB.prepare(
    `INSERT INTO ${def.table} (${cols.join(", ")}) VALUES (${placeholders.join(", ")})`
  ).bind(...binds).run();
  return jsonResp({ ok: true, id: body.id }, env, 201);
}

/** Extracted so adminCreate can delegate when it hits an existing row. */
async function applyAdminUpdate(
  env: Env, def: { table: string; fields: string[] }, resource: string, body: Record<string, unknown>
): Promise<Response> {
  // "Other" is the built-in catch-all retailer — never editable.
  if (resource === "retailers" && body.id === "other") {
    return jsonResp({ ok: false, error: "The 'Other' retailer is built-in and can't be edited." }, env, 400);
  }
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const f of def.fields) {
    if (f === "id") continue;
    if (f in body) { sets.push(`${f} = ?`); binds.push(body[f]); }
  }
  if (resource !== "aisles") { sets.push(`updated_at = ?`); binds.push(nowIso()); }
  if (!sets.length) return jsonResp({ ok: true, id: body.id, noChanges: true }, env);
  binds.push(body.id);
  await env.DB.prepare(`UPDATE ${def.table} SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  return jsonResp({ ok: true, id: body.id }, env);
}

async function adminUpdate(req: Request, env: Env, resource: string): Promise<Response> {
  const def = ADMIN_SCHEMA[resource];
  if (!def) return jsonResp({ ok: false, error: "Unknown resource" }, env, 400);
  const body = await readJson(req);
  if (!body.id) return jsonResp({ ok: false, error: "id required" }, env, 400);

  if (resource === "products" && "default_price" in body && !("default_price_updated_at" in body)) {
    body.default_price_updated_at = body.default_price == null ? null : nowIso();
  }
  if (resource === "locations" && "indicative_price" in body && !("indicative_price_updated_at" in body)) {
    body.indicative_price_updated_at = body.indicative_price == null ? null : nowIso();
  }
  if (resource === "products" && "default_size" in body) {
    body.default_size = normalizeSize(body.default_size as string | null);
  }

  return await applyAdminUpdate(env, def, resource, body);
}

// ─────────────────────────────────────────────────────────────────────────
// Pending-review (AI auto-created products)
// ─────────────────────────────────────────────────────────────────────────
async function getPendingReview(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT id, name, brand, notes, default_brand, default_size, default_quantity,
            default_notes, default_tags, default_retailer_id, created_by,
            review_status, created_at
     FROM products
     WHERE review_status = 'pending'
     ORDER BY created_at DESC`
  ).all();
  return jsonResp({ ok: true, products: results }, env);
}

async function approveProduct(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req);
  const id = body.id as string;
  if (!id) return jsonResp({ ok: false, error: "id required" }, env, 400);
  await env.DB.prepare(
    `UPDATE products SET review_status = NULL, updated_at = ? WHERE id = ?`
  ).bind(nowIso(), id).run();
  return jsonResp({ ok: true }, env);
}

async function rejectProduct(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req);
  const id = body.id as string;
  if (!id) return jsonResp({ ok: false, error: "id required" }, env, 400);
  // Hard-delete: rejected AI products shouldn't linger. Cascades remove the
  // seeded product_location too.
  await env.DB.prepare(`DELETE FROM products WHERE id = ?`).bind(id).run();
  return jsonResp({ ok: true }, env);
}

async function adminDelete(req: Request, env: Env, resource: string): Promise<Response> {
  const def = ADMIN_SCHEMA[resource];
  if (!def) return jsonResp({ ok: false, error: "Unknown resource" }, env, 400);
  const body = await readJson(req);
  const id = body.id as string;
  if (!id) return jsonResp({ ok: false, error: "id required" }, env, 400);
  if (resource === "retailers" && id === "other") {
    return jsonResp({ ok: false, error: "The 'Other' retailer is built-in and can't be deleted." }, env, 400);
  }
  await env.DB.prepare(`DELETE FROM ${def.table} WHERE id = ?`).bind(id).run();
  return jsonResp({ ok: true }, env);
}
