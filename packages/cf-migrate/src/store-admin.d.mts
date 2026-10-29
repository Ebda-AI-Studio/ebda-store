// Types for the StoreDO cutover admin surface (store-admin.mjs), consumed by apps/api (TypeScript).
export const MAX_PAGE_ROWS: number;
export const MAX_BODY_BYTES: number;
export const MAX_DIFF_ROWS: number;
export function authorizeCutover(request: Request, secret: string | undefined): boolean;
export interface StoreAdminContext {
  sql: {
    exec(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>> & {
      toArray(): Record<string, unknown>[];
    };
  };
  transactionSync: (fn: () => void) => void;
}
export function handleStoreAdmin(request: Request, ctx: StoreAdminContext): Promise<Response>;
