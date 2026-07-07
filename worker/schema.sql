-- Shop Wise — D1 schema
-- Re-runnable: drops + recreates everything.
--
-- Stage 4: every table carries household_id (unit of data scoping; catalog is
-- per-household). On an EXISTING database, apply migrations/stage4-01-scoping.sql
-- instead of re-running this file.

PRAGMA foreign_keys = ON;

DROP TABLE IF EXISTS list_items;
DROP TABLE IF EXISTS product_locations;
DROP TABLE IF EXISTS aisles;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS retailers;

-- ─────────────────────────────────────────────────────────────────────────
-- retailers
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE retailers (
  id                  TEXT PRIMARY KEY,           -- slug, e.g. "pnp"
  name                TEXT NOT NULL,
  color               TEXT,                       -- brand hex, e.g. "#e30613"
  kind                TEXT NOT NULL DEFAULT 'physical'
                       CHECK (kind IN ('physical','online','hybrid')),
  online_url_template TEXT,                       -- e.g. "https://www.pnp.co.za/"
  position            INTEGER NOT NULL DEFAULT 0, -- display order
  is_default          INTEGER NOT NULL DEFAULT 0, -- 0 or 1 — only one row should be 1
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  household_id        TEXT NOT NULL DEFAULT 'default'
);
CREATE INDEX idx_retailers_position ON retailers(position);
CREATE INDEX idx_retailers_hh ON retailers(household_id, position);

-- ─────────────────────────────────────────────────────────────────────────
-- aisles (per retailer; absent for online-only retailers)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE aisles (
  id           TEXT PRIMARY KEY,                  -- e.g. "pnp:a3"
  retailer_id  TEXT NOT NULL REFERENCES retailers(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,                     -- "Aisle 3" / "Bakery"
  sub          TEXT,                              -- "Pasta & Rice"
  position     INTEGER NOT NULL DEFAULT 0,        -- store-walk order
  kind         TEXT NOT NULL DEFAULT 'aisle'
                CHECK (kind IN ('aisle','perim')),
  side         TEXT CHECK (side IN ('top','bottom')),  -- perim only
  map_x        REAL,
  map_y        REAL,
  map_w        REAL,
  map_h        REAL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  household_id TEXT NOT NULL DEFAULT 'default'
);
CREATE INDEX idx_aisles_retailer ON aisles(retailer_id, position);
CREATE INDEX idx_aisles_hh ON aisles(household_id, retailer_id, position);

-- ─────────────────────────────────────────────────────────────────────────
-- products (master list, retailer-agnostic)
-- default_brand / default_size are templates copied onto list_items on add.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE products (
  id            TEXT PRIMARY KEY,                  -- UUID
  name          TEXT NOT NULL,
  variant       TEXT,                              -- "Long Life" / "Full Cream" / "Original"
  brand         TEXT,
  notes         TEXT,
  -- Provenance + curation state. created_by ∈ {"human","ai"}; review_status
  -- null = approved; "pending" = AI-created, awaiting human review.
  created_by    TEXT,
  review_status TEXT,
  -- Defaults applied when this product is added to a shopping list. Each is
  -- a "what to use if the caller doesn't specify" hint, not a hard constraint.
  default_brand            TEXT,
  default_size             TEXT,                   -- "1kg" / "4 pack" / "500g"
  default_quantity         INTEGER,                -- e.g. 4 for "4-pack batteries"
  default_notes            TEXT,
  default_tags             TEXT,                   -- comma-separated, e.g. "sixty60"
  default_retailer_id      TEXT REFERENCES retailers(id),
  default_price            REAL,                   -- indicative; agent-updateable
  default_price_updated_at TEXT,                   -- ISO timestamp; auto-set when price changes
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  household_id  TEXT NOT NULL DEFAULT 'default'
);
CREATE INDEX idx_products_name ON products(name COLLATE NOCASE);
CREATE INDEX idx_products_hh ON products(household_id, name COLLATE NOCASE);

-- ─────────────────────────────────────────────────────────────────────────
-- product_locations — the matrix (which aisle at which retailer, what price)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE product_locations (
  id                          TEXT PRIMARY KEY,
  product_id                  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  retailer_id                 TEXT NOT NULL REFERENCES retailers(id) ON DELETE CASCADE,
  aisle_id                    TEXT REFERENCES aisles(id) ON DELETE SET NULL,
  indicative_price            REAL,
  indicative_price_updated_at TEXT,                       -- ISO ts, auto-set when price changes
  is_primary                  INTEGER NOT NULL DEFAULT 0, -- if 1, this retailer is the "default" for the product
  created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  household_id                TEXT NOT NULL DEFAULT 'default',
  UNIQUE (product_id, retailer_id)
);
CREATE INDEX idx_locations_product ON product_locations(product_id);
CREATE INDEX idx_locations_retailer ON product_locations(retailer_id);
CREATE INDEX idx_prodloc_hh ON product_locations(household_id, product_id);

-- ─────────────────────────────────────────────────────────────────────────
-- list_items — the live shopping list (single shared list this phase)
-- quantity / brand / size capture the user's preference per item.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE list_items (
  id                TEXT PRIMARY KEY,           -- UUID
  name              TEXT NOT NULL,              -- denormalised
  product_id        TEXT REFERENCES products(id) ON DELETE SET NULL,
  retailer_id       TEXT REFERENCES retailers(id) ON DELETE SET NULL,
  aisle_id          TEXT REFERENCES aisles(id) ON DELETE SET NULL,
  quantity          INTEGER NOT NULL DEFAULT 1,
  variant           TEXT,                       -- per-item override of product.variant
  brand             TEXT,                       -- "Phillips"
  size              TEXT,                       -- "1kg" / "4 pack" / "1 bag"
  notes             TEXT,                       -- free text
  tags              TEXT,                       -- comma-separated, e.g. "sixty60, no-stock 2026-05-17"
  checked           INTEGER NOT NULL DEFAULT 0,
  fulfilment_mode   TEXT NOT NULL DEFAULT 'in_store'
                     CHECK (fulfilment_mode IN ('in_store','online')),
  online_order_link TEXT,
  external_status   TEXT,                       -- "ordered"|"delivered"|NULL
  source            TEXT NOT NULL DEFAULT 'manual'
                     CHECK (source IN ('manual','pre-do')),
  source_action_id  TEXT,
  source_inbox_id   TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  household_id      TEXT NOT NULL DEFAULT 'default',
  created_by        TEXT
);
CREATE INDEX idx_list_retailer ON list_items(retailer_id);
CREATE INDEX idx_list_source_action ON list_items(source_action_id);
CREATE INDEX idx_list_checked ON list_items(checked);
CREATE INDEX idx_list_hh ON list_items(household_id, checked);
