# 🛒 shop dooo

> Smarter aisles. Faster trips.

*(Previously "Shop Wise" — the brand was renamed to **shop dooo**. The
deployed infrastructure identifiers below still use the original
`shop-wise` slugs; only the user-facing name changed.)*

A family shopping app: cloud-backed catalog, retailer-aware list, AI item
resolver, and a Pre-Do dispatch endpoint so dictated shopping items land
straight in the list.

**Live app:** https://shop-wise.pages.dev
**API:** https://shop-wise-api.apps-8ec.workers.dev
**Repo:** https://github.com/theonelevel-com/shop-dooo

> Open the app URL on your phone → "Add to Home Screen" to install as a
> PWA. On first run, ⚙️ → Connection → paste the auth token (see "Setup
> & secrets" below).

---

## What it does

- **Catalog with variants and per-retailer matrix.** A single product
  ("Milk") can have many variants (Long Life, Full Cream, Eco Fresh,
  Soy) and live at different retailers + aisles with different
  indicative prices. The list shows everything you might want — qty,
  brand, variant, size, price, retailer.
- **Pre-Do integration.** Dictate "add six soy milks" into Pre-Do; the
  classifier + drafter route it to Shop Wise, which auto-resolves the
  product, applies a retailer + aisle + tags + price from your catalog,
  and pops it onto the list.
- **AI resolver.** When the catalog doesn't have an exact match, an
  LLM (DeepSeek by default; Claude also wired) decides match / create /
  skip. New auto-created products land in a **Pending Review** queue
  in Admin → Products so you can curate before they become permanent.
- **Single-line cards.** Each list item shows everything inline:
  qty badge · price · variant · brand · size · tags. Product-level
  internal notes appear on hover and inside the in-store Finder map.
- **Two modes.** *List Mode* for building the list (typing,
  autocomplete, tap to edit). *Shopping Mode* groups by retailer →
  aisle, with a Find map per item (random "You are here" pin + walking
  route on a sample layout — GPS-based positioning is future).
- **Catalog matrix admin.** Pick a product → table of all retailers
  with aisle dropdowns + price inputs. Save All upserts every change
  in one shot. Last-priced timestamp anchors to the right of each
  cell. Save with no diffs just closes.
- **Live sync.** The PWA polls a tiny `/api/list/version` every 10
  seconds while visible; only re-fetches the full list when something
  has actually changed. Items dispatched from Pre-Do while Shop Wise is
  in the background appear on next focus.
- **Daily price-check agent (scaffold).** Cron at 06:00 UTC. Off by
  default. When enabled, scans `product_locations` rows whose
  `indicative_price_updated_at` is older than `PRICE_REFRESH_DAYS` and
  asks the LLM for an updated estimate. Phase 2 will replace the LLM
  estimator with a real retailer fetch.

---

## Architecture

```
                                ┌──────────────────────────────────────────────────────────┐
                                │  YOU + FAMILY  (browsers + iPhone/Android home-screen)   │
                                └──────────────────────────────────────────────────────────┘
                                          │                              │
                                          │ HTTPS / installed PWA        │
                                          ▼                              ▼
                                ┌─────────────────────────┐    ┌──────────────────────┐
                                │  Shop Wise PWA          │    │  Pre-Do PWA          │
                                │  shop-wise.pages.dev    │    │  (your Pre-Do host)  │
                                │  Cloudflare Pages       │    │  Node server         │
                                │  • static HTML/JS/CSS   │    │  • Express proxy     │
                                │  • sw.js offline cache  │    │    → GAS web app     │
                                │  • icons / manifest     │    │  • browser UI        │
                                └─────────────────────────┘    └──────────────────────┘
                                          │                              │
                              ┌───────────┘                  ┌───────────┘
                              │                              │
                              ▼                              ▼
                   ┌─────────────────────────────────────────────────────┐
                   │  Cloudflare Worker — Shop Wise API                  │
                   │  shop-wise-api.apps-8ec.workers.dev                 │
                   │  • TypeScript handlers (src/index.ts +              │
                   │    resolver.ts + llm.ts + price-checker.ts)         │
                   │  • Daily cron 06:00 UTC for price-check (opt-in)    │
                   │  • Bearer-token auth on ALL endpoints except        │
                   │    /api/health and the GET /from-pre-do redirect    │
                   │  • Secrets via wrangler: SHOPWISE_AUTH_TOKEN,       │
                   │    DEEPSEEK_API_KEY, ANTHROPIC_API_KEY (optional)   │
                   └─────────────────────────────────────────────────────┘
                                          │
                              ┌───────────┴────────────┐
                              ▼                        ▼
                   ┌──────────────────────┐  ┌──────────────────────┐
                   │  Cloudflare D1       │  │  DeepSeek API        │
                   │  shopwise (SQLite)   │  │  api.deepseek.com    │
                   │  • retailers         │  │  • Resolver agent    │
                   │  • aisles            │  │    (when MODE = on)  │
                   │  • products          │  │  • Future: price     │
                   │  • product_locations │  │    estimator         │
                   │  • list_items        │  │  Pay per token       │
                   │  WEUR region         │  │                      │
                   └──────────────────────┘  └──────────────────────┘

                   ┌─────────────────────────────────────────────────────┐
                   │  Pre-Do — Google Apps Script web app                │
                   │  (deployed to script.google.com; backed by Sheet)   │
                   │  • Classifier (Claude or DeepSeek)                  │
                   │  • Drafter (Claude or DeepSeek)                     │
                   │  • Dispatcher → POSTs to /api/from-pre-do           │
                   │  Secrets: ANTHROPIC_API_KEY, DEEPSEEK_API_KEY,      │
                   │           SHOPWISE_AUTH_TOKEN                       │
                   └─────────────────────────────────────────────────────┘
```

Every part is on free tiers. LLM calls are pay-per-token.

---

## Privacy

- **All reads and writes require `SHOPWISE_AUTH_TOKEN`.** Anyone without
  the token gets a 401. Your shopping list, catalog, retailers, aisles
  and price history are not publicly readable.
- **The two open endpoints** are intentional and don't expose data:
  - `GET /api/health` returns `{ok:true, version}` — used for monitoring
  - `GET /api/from-pre-do` 302-redirects to the live app — Pre-Do uses
    this as the action's "Open" link so a browser visit lands on the
    app and not on a JSON error page.
- **Frontend HTML/JS/CSS** at `shop-wise.pages.dev` is public (it's the
  app source), but contains no secrets and no personal data. The token
  is stored only in your browser's `localStorage`.
- **GitHub repo** is public, but no secrets / tokens / API keys are in
  it. Cloudflare Worker secrets are set via `wrangler secret put` and
  never touch the repo.
- **What's in D1** is your data, encrypted at rest by Cloudflare; the
  only way to read it is through the Worker, which gates on the token.

### Multi-tenant evolution

Today's "all readers share one token" model is **Phase 1**. The path to
true multi-tenancy:

| Phase | Auth | Data isolation | Effort |
|---|---|---|---|
| **1 (today)** | Shared `SHOPWISE_AUTH_TOKEN` | None — all family members share one dataset | done |
| **2 — household scope** | Cloudflare Access (Google / OIDC / email-OTP — no passwords to maintain). JWT carries `Cf-Access-Authenticated-User-Email` to the Worker. | Add `households` + `users` tables; every existing table grows a `household_id`; every Worker query filters by it. | ~1 day |
| **3 — self-service** | Same CF Access; allow open sign-up. First sign-in creates a fresh household; invite codes add family. | Add a small admin UI for household creation, invites, quota tracking. Phase 2's schema already supports this. | ~half day on top of Phase 2 |

CF Access providers Phase 2/3 can use: Google, Apple, Microsoft / Azure AD,
GitHub, Facebook, LinkedIn, OneLogin, Okta, JumpCloud, generic OIDC,
SAML 2.0, and email-OTP (sign-in code mailed to any address — no
identity provider needed).

---

## Setup & secrets

### One-time, for the deploy

```bash
cd worker
npm install
npx wrangler login                       # browser OAuth into Cloudflare
npx wrangler d1 create shopwise          # paste id into wrangler.toml
npm run db:schema                        # apply schema.sql to remote D1
npm run db:seed                          # apply seed.sql

# Secrets — never in repo
npx wrangler secret put SHOPWISE_AUTH_TOKEN   # any random string
npx wrangler secret put DEEPSEEK_API_KEY      # optional, for AI resolver
npx wrangler secret put ANTHROPIC_API_KEY     # optional, alternate model

npm run deploy                                # Worker live
```

### To turn on the AI resolver

In `worker/wrangler.toml` set `RESOLVER_AI_MODE = "on"` and pick a
`RESOLVER_MODEL` (e.g. `deepseek-chat`). Redeploy. The `/api/list/add`
and `/api/from-pre-do` paths will hand unmatched items to the LLM,
which can `match` an existing product, `create` a new one (flagged
`pending` for review), or `skip` to the "Other" catch-all.

### To turn on the price-check agent

`PRICE_CHECK_MODE = "on"` in `wrangler.toml`. Daily 06:00 UTC scan
asks the LLM for an indicative price for any `product_locations` row
whose timestamp is older than `PRICE_REFRESH_DAYS` (default 30).

### Pages deploy

Manual today:

```bash
npm run build:pages                                  # at repo root
cd worker && npx wrangler pages deploy ../public --project-name=shop-wise --branch=main
```

GitHub-Pages-style auto-deploy (push → publish) is on the roadmap — the
project was created via direct upload, which Cloudflare doesn't let me
convert to a Git-connected project. A GitHub Actions workflow that runs
`wrangler pages deploy` is the planned drop-in.

### Wire Pre-Do

In Pre-Do's GAS Config tab:

| Key | Value |
|---|---|
| `SHOPWISE_ENDPOINT_URL` | `https://shop-wise-api.apps-8ec.workers.dev/api/from-pre-do` |
| `SHOPWISE_AUTH_TOKEN` | the token you set above |

Pre-Do's `postToShopWise_()` sends the token in the request body
(supported by the Worker alongside the Bearer header) so no Pre-Do
code change is needed.

---

## API surface

Reads and writes both require `Authorization: Bearer $SHOPWISE_AUTH_TOKEN`,
except as noted.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | open — health ping |
| GET | `/api/retailers` | list retailers |
| GET | `/api/aisles?retailer=<id>` | list aisles for a retailer |
| GET | `/api/catalog` | full product matrix (products × locations) |
| GET | `/api/list` | current list, with retailer/aisle/price joined |
| GET | `/api/list/version` | tiny stamp for polling diff |
| GET | `/api/products/lookup?name=<text>` | resolve an item to a product/retailer/aisle |
| GET | `/api/from-pre-do` | open — 302 redirect to the app (for Pre-Do's "Open" button) |
| POST | `/api/from-pre-do` | Pre-Do dispatch; accepts token in body OR header |
| POST | `/api/list/add` | add (or merge-by-name) an item |
| POST | `/api/list/check` | tick/untick |
| POST | `/api/list/update` | edit any whitelisted field |
| POST | `/api/list/assign` | re-allocate retailer/aisle |
| POST | `/api/list/delete` | remove an item |
| POST | `/api/list/external-status` | mark items from a Pre-Do action as completed |
| POST | `/api/admin/products` | create/edit/delete (uses upsert on locations) |
| POST | `/api/admin/retailers` | "" |
| POST | `/api/admin/aisles` | "" |
| POST | `/api/admin/locations` | "" |
| GET | `/api/admin/review/pending` | products AI auto-created, awaiting review |
| POST | `/api/admin/review/approve` | accept an AI-created product |
| POST | `/api/admin/review/reject` | delete an AI-created product |

---

## File structure

```
shop-wise/
├── index.html              # Single-file PWA (HTML + CSS + JS)
├── manifest.json           # PWA manifest
├── sw.js                   # Service worker (offline cache, network-first HTML)
├── icons/                  # SVG app icons
├── public/                 # Built output (only PWA files; generated by build:pages)
├── package.json            # Build helper
├── README.md
└── worker/
    ├── src/
    │   ├── index.ts        # Worker routes, auth, admin CRUD
    │   ├── resolver.ts     # Strict + AI item resolver
    │   ├── llm.ts          # Provider router (Anthropic + DeepSeek)
    │   └── price-checker.ts# Daily price-refresh agent (scaffold)
    ├── schema.sql          # D1 table DDL
    ├── seed.sql            # Sample retailers / aisles / products
    ├── wrangler.toml       # Worker + D1 binding + env vars + cron
    └── README.md           # Worker-specific setup notes
```

---

## Roadmap

**Now**
- Cloudflare Access + household-scoped data (Phase 2 multi-tenancy)
- GitHub Actions auto-deploy for Pages (drop the manual `wrangler pages deploy`)
- Offline write queue with background sync (SW + IndexedDB)

**Next**
- Purchase history archive (move ticked items to `list_history`,
  expose `/api/history?tag=…&since=…` + CSV export)
- "Push to Sixty60" handoff button (filter sixty60-tagged items,
  format for clipboard, deep-link the Sixty60 site, auto-tag pushed)
- Walking-route arrows on the Finder map
- Improved per-retailer store layouts (photos / floor plans)

**Later**
- Real-time multi-user sync (CF Durable Objects + WebSockets)
- Receipt scanning to verify prices + log purchases
- Voice / barcode entry
- Geofence push notifications ("you're near PnP, 3 items left")
- Real Sixty60 integration (browser automation or reverse-engineered API)
- GPS-based "You are here" pin

---

## Status

**v3.x — production-shaped, family-scale.** Single-tenant with token auth.
Cloud-backed catalog + retailers + matrix. Pre-Do dispatch wired.
AI resolver wired (off by default; flip via `RESOLVER_AI_MODE`).
Imported 226-product Sixty60 history with brands / variants / sizes /
indicative prices. Skeleton — not for production use by others until
Phase 2 multi-tenancy is in.
