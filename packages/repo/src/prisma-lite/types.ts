export type Meta = {
  models: Record<string, ModelMeta>;
  enums: Record<string, string[]>;
  /** Global omit of the real client (`packages/database/src/client.ts`): fields a query only returns when `select`ed or `omit: { f: false }`. */
  omit?: Record<string, string[]>;
};
export type ModelMeta = {
  table: string;
  db: 'store-do' | 'd1';
  pk: string[];
  uniques: string[][];
  fields: Record<string, FieldMeta>;
};
export type ScalarField = {
  kind: 'scalar' | 'enum';
  type: string;
  column: string;
  list: boolean;
  optional: boolean;
  scale?: number;
  enum?: string;
  default?: string;
  updatedAt?: boolean;
  id?: boolean;
};
export type RelationField = {
  kind: 'relation';
  type: string;
  list: boolean;
  optional: boolean;
  external: boolean;
  owner?: boolean;
  from?: string[];
  fromProps?: string[];
  to?: string[];
  toProps?: string[];
  onDelete?: string | null;
};
export type FieldMeta = ScalarField | RelationField;

/** The synchronous SQL surface of a Durable Object (`ctx.storage.sql`) or node:sqlite in tests. */
export interface SqlRunner {
  all(sql: string, params: unknown[]): Record<string, unknown>[];
  run(sql: string, params: unknown[]): { changes: number };
  /**
   * Run an async closure as ONE transaction (DO: `ctx.storage.transaction`; tests: BEGIN/COMMIT). The closure may
   * await only prisma-lite calls (storage ops); awaiting network I/O inside it forfeits the single-writer guarantee.
   */
  transaction?<T>(fn: () => Promise<T>): Promise<T>;
  /** Optional: run a SYNCHRONOUS unit atomically with no chance of interleaving (DO: `ctx.storage.transactionSync`). Preferred for single writes. */
  transactionSync?<T>(fn: () => T): T;
}

/**
 * The write guard of the RPC path (Ruling CF-R7-4), enforced by the EXECUTOR at the point it writes or links a row, so it
 * reads nested writes exactly the way they run (no second parser to differ from): every model a write reaches, at any
 * depth and through any nested operation (create, connect, connectOrCreate, set, update, delete...), must be `writable`,
 * and no stock column of a model may appear in the data written to it.
 */
export interface WriteGuard {
  writable: ReadonlySet<string>;
  stock: Readonly<Record<string, readonly string[]>>;
}
