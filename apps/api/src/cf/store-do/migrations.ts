import { STORE_MIGRATIONS } from '@ebda-src/cf-schema';
import { splitSql } from '@ebda-src/repo';

// LEGACY (INFRA-CF-1 Phase 0 spike). New StoreDOs never run this: they start on the full generated cf-schema
// (STORE_MIGRATIONS). It stays so a test can rebuild a spike-era DO and prove the upgrade path (runMigrations).
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

// ---- versioned, idempotent migration runner ----------------------------------------------------------------------
/** The id Phase 0 recorded for CORE_0001. Present in `_migrations` = a spike-era DO whose thin tables must go first. */
export const SPIKE_CORE_ID = '0001_core';
/** Child tables first (FKs). The thin spike tables; the full schema re-creates `products` & co. with real columns. */
const SPIKE_TABLES = [
  'order_items',
  'orders',
  'cart_items',
  'carts',
  'product_variants',
  'products',
  'stores',
] as const;

/** The slice of `ctx.storage` the runner uses (structural: this package does not load workers-types globals). */
export interface MigrationStorage {
  sql: {
    exec(q: string, ...b: unknown[]): { toArray(): Array<Record<string, unknown>> };
  };
  transactionSync<T>(fn: () => T): T;
}

interface Migration {
  id: string;
  /** Statements to run, given the ids already applied (so a step can be conditional on history). */
  statements(applied: ReadonlySet<string>): string[];
}

/**
 * Applied in order, each once, each in ONE transaction together with its `_migrations` row (a crash between the DDL
 * and the row cannot leave a half-applied step). Every statement is also idempotent (IF NOT EXISTS), so re-running the
 * list is safe.
 *
 * `cf-0000_drop_spike_core`: a DO that ran Phase 0 has thin `products`/`orders`/... tables (and the spike demo rows,
 * which are disposable test seeds, never merchant data: the spike was reachable only for a flagged demo store). They are
 * dropped so the full table definitions can be created. On a fresh DO it is a recorded no-op.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    id: 'cf-0000_drop_spike_core',
    statements: applied =>
      applied.has(SPIKE_CORE_ID) ? SPIKE_TABLES.map(t => `DROP TABLE IF EXISTS "${t}"`) : [],
  },
  ...STORE_MIGRATIONS.map(m => ({ id: m.id, statements: () => splitSql(m.sql) })),
];

/** Latest schema version: the id of the last migration. A DO reports it so a deploy can be checked against it. */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].id;

export function runMigrations(storage: MigrationStorage, now: number = Date.now()): string[] {
  const sqlx = storage.sql;
  sqlx.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)'
  );
  const done = new Set(
    sqlx
      .exec('SELECT id FROM _migrations')
      .toArray()
      .map(r => r.id as string)
  );
  const ran: string[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    storage.transactionSync(() => {
      for (const stmt of m.statements(done)) sqlx.exec(stmt);
      sqlx.exec('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)', m.id, now);
    });
    done.add(m.id);
    ran.push(m.id);
  }
  return ran;
}
