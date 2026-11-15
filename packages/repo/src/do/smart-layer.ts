import type {
  ApprovalRecord,
  AppliedRecord,
  AuditRow,
  DecisionRow,
  PreviewRecord,
  TurnRow,
} from '../../../shared/src/foundation/smart-layer/types';
import { MoneyError, type SyncSql } from './sync-sql';

/**
 * The assistant's journal on the StoreDO (Smart Layer plan 4, Ruling SL-STORE-1). Turns, audit rows, previews, applied records,
 * approvals, decisions and rate-limit hits live in the store's OWN SQLite, so they share the store's tenancy, backups and erasure.
 * The DO is single-threaded and every operation below runs as ONE `transactionSync` section, so each status compare-and-set
 * (`claimApproval`, `closeApproval`, `transitionPreview`, `markUndone`) has exactly one winner; `workers-do/smart-layer-storage.test.ts`
 * runs the engine's executable storage contract against the real DO to prove it.
 *
 * Text in these rows is already masked by the engine (secrets, phones, e-mails, cards). Retention is 90 days (`purgeBefore`, called by
 * the DO alarm); the rows leave with the store (store-owned in the erasure registry).
 */
export const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

// pq-allow(unused-export): imported by tests/unit/cf-erasure-registry.test.ts
export const SMART_LAYER_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS sl_turns (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, store_id TEXT NOT NULL, thread_id TEXT NOT NULL,
     user_id TEXT NOT NULL, role TEXT NOT NULL, masked_text TEXT NOT NULL, at INTEGER NOT NULL, release_id TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sl_turns_thread ON sl_turns (store_id, thread_id, seq)`,
  `CREATE INDEX IF NOT EXISTS sl_turns_at ON sl_turns (at)`,
  `CREATE TABLE IF NOT EXISTS sl_audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, store_id TEXT NOT NULL, user_id TEXT NOT NULL,
     at INTEGER NOT NULL, json TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sl_audit_store_at ON sl_audit (store_id, at)`,
  `CREATE TABLE IF NOT EXISTS sl_previews (id TEXT NOT NULL, store_id TEXT NOT NULL, user_id TEXT NOT NULL, created_at INTEGER NOT NULL,
     status TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (store_id, id))`,
  `CREATE INDEX IF NOT EXISTS sl_previews_at ON sl_previews (created_at)`,
  `CREATE TABLE IF NOT EXISTS sl_applied (id TEXT NOT NULL, store_id TEXT NOT NULL, user_id TEXT NOT NULL, applied_at INTEGER NOT NULL,
     undone_at INTEGER, json TEXT NOT NULL, PRIMARY KEY (store_id, id))`,
  `CREATE INDEX IF NOT EXISTS sl_applied_at ON sl_applied (applied_at)`,
  `CREATE TABLE IF NOT EXISTS sl_approvals (id TEXT NOT NULL, store_id TEXT NOT NULL, user_id TEXT NOT NULL, preview_id TEXT NOT NULL,
     token_hash TEXT NOT NULL, payload_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
     PRIMARY KEY (store_id, id))`,
  `CREATE INDEX IF NOT EXISTS sl_approvals_at ON sl_approvals (created_at)`,
  `CREATE TABLE IF NOT EXISTS sl_decisions (seq INTEGER PRIMARY KEY AUTOINCREMENT, approval_id TEXT NOT NULL, store_id TEXT NOT NULL,
     decider TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT, at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sl_decisions_approval ON sl_decisions (store_id, approval_id)`,
  `CREATE INDEX IF NOT EXISTS sl_decisions_at ON sl_decisions (at)`,
  `CREATE TABLE IF NOT EXISTS sl_counters (seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sl_counters_key ON sl_counters (key, at)`,
];
export const SMART_LAYER_TABLES = [
  'sl_turns',
  'sl_audit',
  'sl_previews',
  'sl_applied',
  'sl_approvals',
  'sl_decisions',
  'sl_counters',
] as const;

export function ensureSmartLayerSchema(db: SyncSql): void {
  for (const s of SMART_LAYER_DDL) db.run(s, []);
}

type Row = Record<string, unknown>;
/** The term as a whole token: not preceded or followed by a letter or digit (Arabic included), case-insensitive. */
const wholeToken = (term: string): RegExp =>
  new RegExp(
    `(?<![\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`,
    'iu'
  );
const one = (db: SyncSql, sql: string, p: unknown[]): Row | undefined => db.all(sql, p)[0];
// d1-exact-ok: single-row claim on a unique id inside one Durable Object (sync SQLite); exactly-one is the contract
const won = (db: SyncSql, sql: string, p: unknown[]): boolean => db.run(sql, p).changes === 1;
const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || v.length < 1 || v.length > 400)
    throw new MoneyError('BAD_ARGUMENT', `${name} is required`, 400);
  return v;
};

const OPS = {
  appendTurn(db: SyncSql, [r]: [TurnRow]) {
    db.run(
      'INSERT INTO sl_turns (id, store_id, thread_id, user_id, role, masked_text, at, release_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [r.id, r.storeId, r.conversationId, r.userId, r.role, r.maskedText, r.at, r.releaseId]
    );
  },
  loadTurns(db: SyncSql, [storeId, conversationId, limit]: [string, string, number]): TurnRow[] {
    return db
      .all(
        'SELECT id, store_id, thread_id, user_id, role, masked_text, at, release_id FROM (SELECT * FROM sl_turns WHERE store_id = ? AND thread_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq',
        [storeId, conversationId, Math.max(0, Math.floor(limit))]
      )
      .map(t => ({
        id: t.id as string,
        storeId: t.store_id as string,
        conversationId: t.thread_id as string,
        userId: t.user_id as string,
        role: t.role as TurnRow['role'],
        maskedText: t.masked_text as string,
        at: t.at as number,
        releaseId: t.release_id as string,
      }));
  },
  appendAudit(db: SyncSql, [r]: [AuditRow]) {
    db.run('INSERT INTO sl_audit (id, store_id, user_id, at, json) VALUES (?, ?, ?, ?, ?)', [
      r.id,
      r.storeId,
      r.userId,
      r.at,
      JSON.stringify(r),
    ]);
  },
  loadAudits(db: SyncSql, [storeId, sinceMs, limit]: [string, number, number]): AuditRow[] {
    return db
      .all(
        'SELECT json FROM (SELECT seq, json FROM sl_audit WHERE store_id = ? AND at >= ? ORDER BY seq DESC LIMIT ?) ORDER BY seq',
        [storeId, sinceMs, Math.max(0, Math.floor(limit))]
      )
      .map(r => JSON.parse(r.json as string) as AuditRow);
  },
  putPreview(db: SyncSql, [r]: [PreviewRecord]) {
    const { status, ...rest } = r;
    db.run(
      'INSERT OR REPLACE INTO sl_previews (id, store_id, user_id, created_at, status, json) VALUES (?, ?, ?, ?, ?, ?)',
      [r.id, r.storeId, r.userId, r.createdAt, status, JSON.stringify(rest)]
    );
  },
  getPreview(db: SyncSql, [storeId, id]: [string, string]): PreviewRecord | null {
    const r = one(db, 'SELECT status, json FROM sl_previews WHERE store_id = ? AND id = ?', [
      storeId,
      id,
    ]);
    return r
      ? ({ ...(JSON.parse(r.json as string) as object), status: r.status } as PreviewRecord)
      : null;
  },
  transitionPreview(
    db: SyncSql,
    [storeId, id, from, to]: [string, string, string, string]
  ): boolean {
    return won(
      db,
      'UPDATE sl_previews SET status = ? WHERE store_id = ? AND id = ? AND status = ?',
      [to, storeId, id, from]
    );
  },
  putApplied(db: SyncSql, [r]: [AppliedRecord]) {
    const { undoneAt, ...rest } = r;
    db.run(
      'INSERT OR REPLACE INTO sl_applied (id, store_id, user_id, applied_at, undone_at, json) VALUES (?, ?, ?, ?, ?, ?)',
      [r.id, r.storeId, r.userId, r.appliedAt, undoneAt ?? null, JSON.stringify(rest)]
    );
  },
  getApplied(db: SyncSql, [storeId, id]: [string, string]): AppliedRecord | null {
    const r = one(db, 'SELECT undone_at, json FROM sl_applied WHERE store_id = ? AND id = ?', [
      storeId,
      id,
    ]);
    return r
      ? ({
          ...(JSON.parse(r.json as string) as object),
          ...(r.undone_at !== null ? { undoneAt: r.undone_at } : {}),
        } as AppliedRecord)
      : null;
  },
  markUndone(db: SyncSql, [storeId, id, now]: [string, string, number]): boolean {
    return won(
      db,
      'UPDATE sl_applied SET undone_at = ? WHERE store_id = ? AND id = ? AND undone_at IS NULL',
      [now, storeId, id]
    );
  },
  unmarkUndone(db: SyncSql, [storeId, id]: [string, string]): boolean {
    return won(
      db,
      'UPDATE sl_applied SET undone_at = NULL WHERE store_id = ? AND id = ? AND undone_at IS NOT NULL',
      [storeId, id]
    );
  },
  putApproval(db: SyncSql, [r]: [ApprovalRecord]) {
    db.run(
      'INSERT OR REPLACE INTO sl_approvals (id, store_id, user_id, preview_id, token_hash, payload_hash, expires_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        r.id,
        r.storeId,
        r.userId,
        r.previewId,
        r.tokenHash,
        r.payloadHash,
        r.expiresAt,
        r.status,
        r.createdAt,
      ]
    );
  },
  getApproval(db: SyncSql, [storeId, id]: [string, string]): ApprovalRecord | null {
    const r = one(db, 'SELECT * FROM sl_approvals WHERE store_id = ? AND id = ?', [storeId, id]);
    return r
      ? {
          id: r.id as string,
          storeId: r.store_id as string,
          userId: r.user_id as string,
          previewId: r.preview_id as string,
          tokenHash: r.token_hash as string,
          payloadHash: r.payload_hash as string,
          expiresAt: r.expires_at as number,
          status: r.status as ApprovalRecord['status'],
          createdAt: r.created_at as number,
        }
      : null;
  },
  closeApproval(db: SyncSql, [storeId, id, to]: [string, string, string]): boolean {
    if (to !== 'rejected' && to !== 'expired') throw new MoneyError('BAD_ARGUMENT', 'to', 400);
    return won(
      db,
      "UPDATE sl_approvals SET status = ? WHERE store_id = ? AND id = ? AND status = 'pending'",
      [to, storeId, id]
    );
  },
  /** Check order (the engine relies on it): missing, then mismatch (token or payload), then used, then expired, then the single-winner claim. */
  claimApproval(
    db: SyncSql,
    [storeId, id, tokenHash, payloadHash, now]: [string, string, string, string, number]
  ): 'claimed' | 'used' | 'expired' | 'mismatch' | 'missing' {
    const a = one(
      db,
      'SELECT token_hash, payload_hash, status, expires_at FROM sl_approvals WHERE store_id = ? AND id = ?',
      [storeId, id]
    );
    if (!a) return 'missing';
    if (a.token_hash !== tokenHash || a.payload_hash !== payloadHash) return 'mismatch';
    if (a.status !== 'pending') return 'used';
    if ((a.expires_at as number) <= now) {
      db.run(
        "UPDATE sl_approvals SET status = 'expired' WHERE store_id = ? AND id = ? AND status = 'pending'",
        [storeId, id]
      );
      return 'expired';
    }
    return won(
      db,
      "UPDATE sl_approvals SET status = 'used' WHERE store_id = ? AND id = ? AND status = 'pending' AND token_hash = ? AND payload_hash = ? AND expires_at > ?",
      [storeId, id, tokenHash, payloadHash, now]
    )
      ? 'claimed'
      : 'used';
  },
  recordDecision(db: SyncSql, [r]: [DecisionRow]) {
    db.run(
      'INSERT INTO sl_decisions (approval_id, store_id, decider, decision, reason, at) VALUES (?, ?, ?, ?, ?, ?)',
      [r.approvalId, r.storeId, r.decider, r.decision, r.reason ?? null, r.at]
    );
  },
  loadDecisions(db: SyncSql, [storeId, approvalId]: [string, string]): DecisionRow[] {
    return db
      .all(
        'SELECT approval_id, store_id, decider, decision, reason, at FROM sl_decisions WHERE store_id = ? AND approval_id = ? ORDER BY seq',
        [storeId, approvalId]
      )
      .map(d => ({
        approvalId: d.approval_id as string,
        storeId: d.store_id as string,
        decider: d.decider as string,
        decision: d.decision as DecisionRow['decision'],
        ...(d.reason !== null ? { reason: d.reason as string } : {}),
        at: d.at as number,
      }));
  },
  /** Sliding window: one row per hit, hits older than the window are dropped, the count includes this one. */
  bump(db: SyncSql, [key, windowMs, now]: [string, number, number]): number {
    db.run('DELETE FROM sl_counters WHERE key = ? AND at <= ?', [key, now - windowMs]);
    db.run('INSERT INTO sl_counters (key, at) VALUES (?, ?)', [key, now]);
    return one(db, 'SELECT count(*) AS n FROM sl_counters WHERE key = ?', [key])!.n as number;
  },
  /** For feedback: does this user own an answered turn with this id, and have they already rated it? (outside the engine's storage interface) */
  turnState(
    db: SyncSql,
    [storeId, userId, turnId]: [string, string, string]
  ): { own: boolean; rated: boolean } {
    const q = (feedback: boolean): boolean =>
      (one(
        db,
        `SELECT count(*) AS n FROM sl_audit WHERE store_id = ? AND user_id = ? AND json_extract(json, '$.turnId') = ? AND (json_extract(json, '$.releaseId') = 'feedback') = ?`,
        [storeId, userId, turnId, feedback ? 1 : 0]
      )!.n as number) > 0;
    return { own: q(false), rated: q(true) };
  },
  /**
   * Customer erasure: the masked journal may still carry the person's NAME (masking removes phones, e-mails and cards, not names).
   * A term matches only as a WHOLE token (never inside a longer word or number) and is expected to be identifying: a customer id, an e-mail, a phone,
   * or a FULL name. A bare first name is never passed in, so a different shopper who shares it is untouched.
   */
  eraseMentions(db: SyncSql, [terms]: [string[]]): number {
    let n = 0;
    for (const raw of terms) {
      const t = String(raw ?? '').trim();
      if (t.length < 3) continue;
      const hit = wholeToken(t);
      for (const [table, col] of [
        ['sl_turns', 'masked_text'],
        ['sl_audit', 'json'],
      ] as const) {
        const rows = db.all(
          `SELECT seq, ${col} AS v FROM ${table} WHERE instr(lower(${col}), lower(?)) > 0`,
          [t]
        );
        for (const r of rows) {
          if (!hit.test(String(r.v ?? ''))) continue;
          db.run(`DELETE FROM ${table} WHERE seq = ?`, [r.seq]);
          n += 1;
        }
      }
    }
    return n;
  },
  /** User erasure (merchant / staff account): every journal row this user wrote or decided, in this store's DO. */
  eraseUserEverywhere(db: SyncSql, [userId]: [string]): number {
    let n = 0;
    for (const [t, col] of [
      ['sl_turns', 'user_id'],
      ['sl_audit', 'user_id'],
      ['sl_previews', 'user_id'],
      ['sl_applied', 'user_id'],
      ['sl_approvals', 'user_id'],
      ['sl_decisions', 'decider'],
    ] as const) {
      n += one(db, `SELECT count(*) AS n FROM ${t} WHERE ${col} = ?`, [userId])!.n as number;
      db.run(`DELETE FROM ${t} WHERE ${col} = ?`, [userId]);
    }
    return n;
  },
  eraseStore(db: SyncSql, [storeId]: [string]) {
    for (const t of [
      'sl_turns',
      'sl_audit',
      'sl_previews',
      'sl_applied',
      'sl_approvals',
      'sl_decisions',
    ])
      db.run(`DELETE FROM ${t} WHERE store_id = ?`, [storeId]);
    db.run("DELETE FROM sl_counters WHERE key LIKE ? ESCAPE '\\'", [
      `%${storeId.replace(/[\\%_]/g, '\\$&')}%`,
    ]);
  },
  eraseUser(db: SyncSql, [storeId, userId]: [string, string]) {
    for (const t of ['sl_turns', 'sl_audit', 'sl_previews', 'sl_applied', 'sl_approvals'])
      db.run(`DELETE FROM ${t} WHERE store_id = ? AND user_id = ?`, [storeId, userId]);
    db.run('DELETE FROM sl_decisions WHERE store_id = ? AND decider = ?', [storeId, userId]);
  },
  purgeBefore(db: SyncSql, [cutoff]: [number]): number {
    let n = 0;
    for (const [t, col] of [
      ['sl_turns', 'at'],
      ['sl_audit', 'at'],
      ['sl_previews', 'created_at'],
      ['sl_applied', 'applied_at'],
      ['sl_approvals', 'created_at'],
      ['sl_decisions', 'at'],
    ] as const) {
      n += one(db, `SELECT count(*) AS n FROM ${t} WHERE ${col} < ?`, [cutoff])!.n as number;
      db.run(`DELETE FROM ${t} WHERE ${col} < ?`, [cutoff]);
    }
    db.run('DELETE FROM sl_counters WHERE at < ?', [cutoff]); // rate-limit hits, not records: not counted
    return n;
  },
};
export type SmartLayerOp = keyof typeof OPS;
export const SMART_LAYER_OPS = Object.keys(OPS) as SmartLayerOp[];

/** Run one named operation as one atomic section. An unknown op is a 400, never a dynamic call. */
export function runSmartLayerOp(db: SyncSql, op: string, args: unknown): unknown {
  if (!Object.prototype.hasOwnProperty.call(OPS, op))
    throw new MoneyError('UNKNOWN_OP', 'unknown smart layer operation', 400);
  if (!Array.isArray(args)) throw new MoneyError('BAD_ARGUMENT', 'args must be a list', 400);
  if (typeof args[0] === 'string') str(args[0], 'storeId');
  return db.transactionSync(() =>
    (OPS[op as SmartLayerOp] as (d: SyncSql, a: never) => unknown)(db, args as never)
  );
}

export type SmartLayerAnswer =
  | { ok: true; json: string }
  | { ok: false; code: string; status: number; message: string };

/** The RPC answer: a refusal is an ANSWER (the DO never throws across the boundary). Plain JSON: no Date, no Decimal travels here. */
export function answerSmartLayerOp(db: SyncSql, op: string, argsJson: string): SmartLayerAnswer {
  try {
    return {
      ok: true,
      json: JSON.stringify(runSmartLayerOp(db, op, JSON.parse(argsJson)) ?? null),
    };
  } catch (e) {
    if (e instanceof MoneyError)
      return { ok: false, code: e.code, status: e.status, message: e.message };
    return {
      ok: false,
      code: 'SMART_LAYER_OP_FAILED',
      status: 500,
      message: 'smart layer operation failed',
    };
  }
}
