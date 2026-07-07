-- stage4-01-scoping.sql — household_id on every shopwise table (ADDITIVE).
-- Existing rows backfill to the founding 'default' household. The catalog
-- (retailers/aisles/products/product_locations) is per-household — a new
-- household starts with an empty catalog (starter-catalog clone deferred).
--
-- Apply:  wrangler d1 execute shopwise --file=migrations/stage4-01-scoping.sql
--         wrangler d1 execute shopwise --remote --file=migrations/stage4-01-scoping.sql

ALTER TABLE list_items        ADD COLUMN household_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE list_items        ADD COLUMN created_by   TEXT;
ALTER TABLE retailers         ADD COLUMN household_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE aisles            ADD COLUMN household_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE products          ADD COLUMN household_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE product_locations ADD COLUMN household_id TEXT NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS idx_list_hh      ON list_items(household_id, checked);
CREATE INDEX IF NOT EXISTS idx_retailers_hh ON retailers(household_id, position);
CREATE INDEX IF NOT EXISTS idx_aisles_hh    ON aisles(household_id, retailer_id, position);
CREATE INDEX IF NOT EXISTS idx_products_hh  ON products(household_id, name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_prodloc_hh   ON product_locations(household_id, product_id);
