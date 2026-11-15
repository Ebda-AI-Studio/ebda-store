import { DatabaseSync } from 'node:sqlite';
import { ensureSmartLayerSchema, runSmartLayerOp } from '../../packages/repo/src/do/smart-layer';
import type { SyncSql } from '../../packages/repo/src/do/sync-sql';

/** A real SQLite (node:sqlite) behind the journal operations: the same SQL the StoreDO runs, one fresh database per call. */
export function nodeJournal() {
  const raw = new DatabaseSync(':memory:');
  const db: SyncSql = {
    all: (q, p) => raw.prepare(q).all(...(p as never[])) as Record<string, unknown>[],
    run: (q, p) => ({ changes: Number(raw.prepare(q).run(...(p as never[])).changes) }),
    transactionSync: fn => {
      raw.exec('BEGIN');
      try {
        const r = fn();
        raw.exec('COMMIT');
        return r;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  };
  ensureSmartLayerSchema(db);
  const call = async (op: string, args: unknown[]) =>
    JSON.parse(JSON.stringify(runSmartLayerOp(db, op, args) ?? null)) as unknown;
  return { db, raw, call };
}
