// Generated from spikes/store-do/migrations/0001_core.sql (kept as TS so the Worker needs no .sql module rule).
export const CORE_0001 = `
-- Core 5 tables (+ their two item child tables) for the StoreDO spike. Money = integer piastres,
-- enums = CHECK, JSON = TEXT, time = INTEGER epoch ms. Columns mirror schema.prisma models
-- Store :194, Product :926, ProductVariant :1248, Cart :1542 (+CartItem), Order :1681 (+OrderItem),
-- only the columns the 3 spike endpoints use.
CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EGP',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  name TEXT NOT NULL,
  name_ar TEXT,
  slug TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price >= 0),
  compare_at_price INTEGER,
  inventory INTEGER NOT NULL DEFAULT 0 CHECK (inventory >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','archived')),
  has_variants INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS products_store_slug ON products (store_id, slug);
CREATE INDEX IF NOT EXISTS products_store_status_created ON products (store_id, status, created_at DESC);
CREATE TABLE IF NOT EXISTS product_variants (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  sku TEXT,
  price INTEGER NOT NULL CHECK (price >= 0),
  inventory INTEGER NOT NULL DEFAULT 0 CHECK (inventory >= 0),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS variants_product ON product_variants (product_id);
CREATE TABLE IF NOT EXISTS carts (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','converted','abandoned')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS carts_store_session ON carts (store_id, session_id);
CREATE TABLE IF NOT EXISTS cart_items (
  id TEXT PRIMARY KEY,
  cart_id TEXT NOT NULL REFERENCES carts (id) ON DELETE CASCADE,
  store_id TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products (id),
  variant_id TEXT REFERENCES product_variants (id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cart_items_cart ON cart_items (cart_id);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  order_number INTEGER NOT NULL,
  cart_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','cancelled','refunded')),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cod','instapay','card')),
  subtotal INTEGER NOT NULL CHECK (subtotal >= 0),
  total INTEGER NOT NULL CHECK (total >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS orders_store_number ON orders (store_id, order_number);
CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  store_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  variant_id TEXT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price INTEGER NOT NULL CHECK (unit_price >= 0)
);
CREATE INDEX IF NOT EXISTS order_items_order ON order_items (order_id);
`;
