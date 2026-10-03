-- Ebda Workers spike: tables + non-bypass role + FORCE RLS.
-- GUC names are FWB's: app.current_store_id / app.current_user_id.
-- DIVERGENCE FROM FWB: FWB policies are "allow-contextless"
--   (current_store_id() IS NULL OR store_id = current_store_id()),
-- i.e. an unset GUC returns EVERY tenant's rows. Here the policies are STRICT:
-- unset GUC => NULL comparison => zero rows / INSERT rejected.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ebda_app') THEN
    CREATE ROLE ebda_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

CREATE TABLE stores (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  custom_domain TEXT UNIQUE,
  created_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE products (
  id           TEXT PRIMARY KEY,
  store_id     TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  price_piastres INTEGER NOT NULL CHECK (price_piastres >= 0),
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX products_store_id_idx ON products(store_id);

CREATE TABLE carts (
  id         TEXT PRIMARY KEY,
  store_id   TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  user_id    TEXT,
  session_id TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open',          -- open | paid
  paid_at    TIMESTAMP(3),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (store_id, session_id)
);

CREATE TABLE cart_items (
  id         TEXT PRIMARY KEY,
  cart_id    TEXT NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity   INTEGER NOT NULL CHECK (quantity > 0),
  UNIQUE (cart_id, product_id)
);

CREATE TABLE webhook_events (
  id          TEXT PRIMARY KEY,
  store_id    TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  raw_body    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'received',
  received_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT webhook_events_provider_event_id_key UNIQUE (provider, event_id)
);

-- ---- GUC accessors (same shape as FWB's) ----
CREATE OR REPLACE FUNCTION current_store_id() RETURNS TEXT AS $$
BEGIN
  RETURN NULLIF(current_setting('app.current_store_id', true), '');
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END; $$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION current_user_id() RETURNS TEXT AS $$
BEGIN
  RETURN NULLIF(current_setting('app.current_user_id', true), '');
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END; $$ LANGUAGE plpgsql STABLE;

-- ---- Host -> store resolution, BEFORE a tenant is known ----
-- stores has no tenant GUC to key on yet, so ebda_app gets no direct SELECT on
-- it. A SECURITY DEFINER function (owner = migration role, bypasses RLS) returns
-- ONLY the id for an exact slug / custom_domain match. Never a "first store".
CREATE OR REPLACE FUNCTION resolve_store_id(p_slug TEXT, p_domain TEXT) RETURNS TEXT AS $$
  SELECT id FROM stores
  WHERE (p_slug IS NOT NULL AND slug = p_slug)
     OR (p_domain IS NOT NULL AND custom_domain = p_domain)
  LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION resolve_store_id(TEXT, TEXT) FROM PUBLIC;

ALTER TABLE stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE stores FORCE ROW LEVEL SECURITY;   -- no policy for ebda_app => deny-all
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE products FORCE ROW LEVEL SECURITY;
ALTER TABLE carts ENABLE ROW LEVEL SECURITY;
ALTER TABLE carts FORCE ROW LEVEL SECURITY;
ALTER TABLE cart_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE cart_items FORCE ROW LEVEL SECURITY;
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events FORCE ROW LEVEL SECURITY;

CREATE POLICY rls_products_tenant ON products FOR ALL TO ebda_app
  USING (store_id = current_store_id()) WITH CHECK (store_id = current_store_id());
CREATE POLICY rls_carts_tenant ON carts FOR ALL TO ebda_app
  USING (store_id = current_store_id()) WITH CHECK (store_id = current_store_id());
CREATE POLICY rls_cart_items_tenant ON cart_items FOR ALL TO ebda_app
  USING (EXISTS (SELECT 1 FROM carts c WHERE c.id = cart_items.cart_id AND c.store_id = current_store_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM carts c WHERE c.id = cart_items.cart_id AND c.store_id = current_store_id()));
CREATE POLICY rls_webhook_events_tenant ON webhook_events FOR ALL TO ebda_app
  USING (store_id = current_store_id()) WITH CHECK (store_id = current_store_id());

GRANT USAGE ON SCHEMA public TO ebda_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON products, carts, cart_items, webhook_events TO ebda_app;
GRANT EXECUTE ON FUNCTION resolve_store_id(TEXT, TEXT) TO ebda_app;
