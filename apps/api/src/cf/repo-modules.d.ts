// Ambient types for the workspace SOURCE packages the Worker bundles. The API typechecks under NodeNext/CommonJS; those
// packages are ESM with extension-less imports (they typecheck under their own `bundler` tsconfig, `npm run typecheck`),
// so importing them by package name would pull their sources into THIS program and fail. The Worker therefore imports
// them under names TypeScript cannot resolve, declared here, and the real files are wired in by name:
//   '@ebda-src/repo'        -> packages/repo/src/index.ts
//   '@ebda-src/cf-schema'   -> packages/cf-schema/src/store/migrations.generated.ts
//   '@ebda-src/prisma-meta' -> packages/cf-schema/generated/prisma-meta.json
// in apps/api/wrangler.jsonc "alias" (esbuild), vitest.shared.ts workspaceAliases and the two apps/api vitest
// configs (vite). tests/unit/cf-repo-modules-shim.test.ts fails when a name declared here is missing from the real module.
// Same idea as ./cloudflare-modules.d.ts for `cloudflare:*`.
declare module '@ebda-src/cf-schema' {
  export const STORE_MIGRATIONS: ReadonlyArray<{ id: string; sql: string }>;
}
declare module '@ebda-src/prisma-meta' {
  const meta: unknown;
  export default meta;
}
declare module '@ebda-src/repo' {
  /** Opaque model metadata (packages/cf-schema/generated/prisma-meta.json). */
  export interface Meta {
    models: Record<string, unknown>;
    enums: Record<string, string[]>;
  }
  export interface SyncSql {
    all(sql: string, params: unknown[]): Record<string, unknown>[];
    run(sql: string, params: unknown[]): { changes: number };
    transactionSync<T>(fn: () => T): T;
  }
  export interface DoStorageLike {
    sql: {
      exec(
        query: string,
        ...bindings: unknown[]
      ): { toArray(): Record<string, unknown>[]; rowsWritten: number };
    };
    transactionSync<T>(fn: () => T): T;
    transaction<T>(fn: () => Promise<T>): Promise<T>;
  }
  export type SqlRunner = unknown;
  export class MoneyError extends Error {
    readonly code: string;
    readonly status: number;
    readonly meta?: Record<string, unknown>;
  }
  export function splitSql(sql: string): string[];
  export function doSqlRunner(storage: DoStorageLike): SqlRunner;
  export function doSyncSql(storage: DoStorageLike): SyncSql;
  export function createPrismaLite(
    meta: Meta,
    sql: SqlRunner,
    db?: 'store-do' | 'd1',
    opts?: { storeId?: string; unscoped?: boolean }
  ): unknown;
  export function ensureSearchIndex(db: SyncSql): void;
  export function ensurePaymentSchema(db: SyncSql): void;
  export interface CheckoutInput {
    storeId: string;
    lines: Array<{ productId: string; variantId?: string; quantity: number }>;
    cart?: { id: string };
    paymentMethod?: string;
    shippingAddress: Record<string, unknown>;
  }
  export interface PlacedOrder {
    orderId: string;
    orderNumber: string;
    total: number;
  }
  export function placeOrder(db: SyncSql, input: CheckoutInput): PlacedOrder;
  export const READ_OPS: readonly [
    'findMany',
    'findFirst',
    'findUnique',
    'findFirstOrThrow',
    'findUniqueOrThrow',
    'count',
  ];
  export type ReadOp = (typeof READ_OPS)[number];
  export interface DoQuery {
    model: string;
    op: ReadOp;
    args?: Record<string, unknown>;
  }
  export type DoQueryResult =
    | { ok: true; json: string }
    | { ok: false; code: string; message: string; json?: string };
  export function runReads(
    lite: Record<string, unknown>,
    queries: readonly DoQuery[]
  ): Promise<DoQueryResult>;
  export function rethrow(r: Extract<DoQueryResult, { ok: false }>): never;
  export function encodeRpc(value: unknown): string;
  export function decodeRpc<T = unknown>(text: string): T;
  export type DoTransport = (queries: DoQuery[]) => Promise<DoQueryResult>;
  export interface DoMutation {
    key?: string;
    ops: Array<{ model: string; op: string; args?: Record<string, unknown> }>;
  }
  export type DoMutateTransport = (m: DoMutation) => Promise<DoQueryResult>;
  export function runWrites(
    lite: Record<string, unknown>,
    sql: SqlRunner,
    m: DoMutation
  ): Promise<DoQueryResult>;
  export function ensureIdempotencySchema(sql: SqlRunner): void;
  export function applyStoreSettings(
    sql: SqlRunner,
    meta: Meta,
    storeId: string,
    fields: Record<string, unknown>
  ): { profile: string[]; config: string[]; directoryOnly: string[] };
  export const DO_PROCS: Record<string, unknown>;
  export const PROC_MODEL: string;
  export const DO_WRITABLE_MODELS: ReadonlySet<string>;
  export function createDoClient(send: DoTransport, mutate?: DoMutateTransport): StoreReadClient;
  /** Prisma-shaped read client of one store's Durable Object. Delegates are typed loosely: callers narrow. */
  export type StoreReadClient = Record<
    string,
    Record<ReadOp, (args?: Record<string, unknown>) => PromiseLike<any>>
  > & {
    $transaction(
      reads: PromiseLike<unknown>[],
      opts?: { idempotencyKey?: string }
    ): Promise<unknown[]>;
  };
}
