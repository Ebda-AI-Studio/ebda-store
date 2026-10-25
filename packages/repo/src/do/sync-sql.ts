/** The synchronous SQL + transaction surface the money/stock core needs (DO: `ctx.storage`; tests: node:sqlite). */
export interface SyncSql {
  all(sql: string, params: unknown[]): Record<string, unknown>[];
  run(sql: string, params: unknown[]): { changes: number };
  /** One atomic unit with no interleaving: any throw rolls EVERYTHING back. */
  transactionSync<T>(fn: () => T): T;
}

export class MoneyError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
    readonly meta?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'MoneyError';
  }
}
