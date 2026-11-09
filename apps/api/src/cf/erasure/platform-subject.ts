/**
 * PDPL export + erasure of one USER's rows on the platform D1 (`ebda-platform`), driven by
 * packages/cf-schema/erasure-classification.json (Ruling FOLD-ERASURE-1). The classification is the single list of what is personal:
 *   - `subjectColumns`  the row IS the person's (memberships, devices, acceptances, API keys)  -> exported, DELETED on erasure
 *   - `actorScrub`      a user id on a row that survives the user (audit, approvals, invites)  -> id exported, replaced on erasure
 *   - `staff_invites`   matched by the person's e-mail address: pending ones are revoked, the address is overwritten
 * A newly classified column is therefore handled with no code change, and `tests/unit/platform-subject-coverage.test.ts` runs this
 * engine over the REAL platform schema and fails when a personal-data table is not reachable from it (or not on its allowlist).
 * Money records are never deleted: actor columns are replaced, payer fields are the payments erasure port's job (N-27).
 */
import classification from '../../../../../packages/cf-schema/erasure-classification.json';

export interface D1Like {
  prepare(sql: string): {
    bind(...v: unknown[]): {
      all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
      first<T = Record<string, unknown>>(): Promise<T | null>;
      run(): Promise<{ meta?: { changes?: number } }>;
    };
  };
  batch(stmts: unknown[]): Promise<Array<{ meta?: { changes?: number } }>>;
}

type Entry = {
  db: 'store-do' | 'd1';
  class: string;
  action: string;
  subjectColumns?: string[];
  actorScrub?: Record<string, string | null>;
};
const ENTRIES = classification as unknown as Record<string, Entry>;

/** Secrets that must never leave in an export (the subject asked for their data, not for credentials). */
export const EXPORT_EXCLUDE: Record<string, string[]> = { merchant_api_keys: ['key_hash'] };

/** Address-keyed table: rows matched by the person's e-mail, not by a user id. */
export const INVITE_TABLE = 'staff_invites';

export interface PlatformPlan {
  /** table -> columns whose value is the user id and whose row is the person's: exported, deleted. */
  subject: Record<string, string[]>;
  /** table -> { column: replacement }: exported as rowid + column, replaced. */
  actor: Record<string, Record<string, string | null>>;
}

export function platformPlan(): PlatformPlan {
  const subject: PlatformPlan['subject'] = {};
  const actor: PlatformPlan['actor'] = {};
  for (const [key, e] of Object.entries(ENTRIES)) {
    if (e.db !== 'd1') continue;
    const table = key.split(':')[1];
    if (e.subjectColumns?.length) subject[table] = e.subjectColumns;
    if (e.actorScrub && Object.keys(e.actorScrub).length) actor[table] = e.actorScrub;
  }
  return { subject, actor };
}

export interface PlatformSubject {
  userId: string;
  email: string | null;
}

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

async function rows(d1: D1Like, sql: string, ...bind: unknown[]) {
  return (
    (
      await d1
        .prepare(sql)
        .bind(...bind)
        .all()
    ).results ?? []
  );
}

/** Every platform-D1 row that is this user's, as `{ table: rows[] }` (no secrets, no other person's payer data). */
export async function exportPlatformSubject(
  d1: D1Like,
  s: PlatformSubject,
  plan: PlatformPlan = platformPlan()
): Promise<Record<string, Array<Record<string, unknown>>>> {
  const out: Record<string, Array<Record<string, unknown>>> = {};
  for (const [table, cols] of Object.entries(plan.subject)) {
    const where = cols.map(c => `${ident(c)} = ?1`).join(' OR ');
    const all = await rows(d1, `SELECT * FROM ${ident(table)} WHERE ${where}`, s.userId);
    const drop = new Set(EXPORT_EXCLUDE[table] ?? []);
    out[table] = all.map(r => Object.fromEntries(Object.entries(r).filter(([k]) => !drop.has(k))));
  }
  for (const [table, cols] of Object.entries(plan.actor)) {
    const names = Object.keys(cols);
    const where = names.map(c => `${ident(c)} = ?1`).join(' OR ');
    // not every table has an `id` (provider_verifications is keyed by provider): the rowid names the row in every case
    const sel = ['rowid AS row_ref', ...names.map(ident)].join(', ');
    const got = await rows(d1, `SELECT ${sel} FROM ${ident(table)} WHERE ${where}`, s.userId);
    if (got.length) out[`${table}(actor)`] = got;
  }
  if (s.email) {
    out[INVITE_TABLE] = await rows(
      d1,
      `SELECT id, store_id, email, role, status, created_at FROM ${ident(INVITE_TABLE)} WHERE lower(email) = lower(?1)`,
      s.email
    );
  }
  return out;
}

/** Rows still holding this person after an erase (must be 0). */
export async function countPlatformSubject(
  d1: D1Like,
  s: PlatformSubject,
  plan: PlatformPlan = platformPlan()
): Promise<number> {
  const parts: string[] = [];
  const bind: unknown[] = [s.userId];
  for (const [table, cols] of Object.entries(plan.subject))
    parts.push(
      `(SELECT count(*) FROM ${ident(table)} WHERE ${cols.map(c => `${ident(c)} = ?1`).join(' OR ')})`
    );
  for (const [table, cols] of Object.entries(plan.actor))
    parts.push(
      `(SELECT count(*) FROM ${ident(table)} WHERE ${Object.keys(cols)
        .map(c => `${ident(c)} = ?1`)
        .join(' OR ')})`
    );
  if (s.email) {
    bind.push(s.email);
    parts.push(
      `(SELECT count(*) FROM ${ident(INVITE_TABLE)} WHERE lower(email) = lower(?2) AND email NOT LIKE 'erased-%@anonymized.invalid')`
    );
  }
  const r = await d1
    .prepare(`SELECT ${parts.join(' + ')} AS n`)
    .bind(...bind)
    .first<{ n: number }>();
  return Number(r?.n ?? 0);
}

/**
 * Erase the user from the platform D1 in ONE atomic batch, then read back. Idempotent. Throws when anything remains, so the caller
 * never reports an erasure as done that was not.
 */
export async function erasePlatformSubject(
  d1: D1Like,
  s: PlatformSubject,
  now: number = Date.now(),
  plan: PlatformPlan = platformPlan()
): Promise<{ changed: number }> {
  const stmts: unknown[] = [];
  for (const [table, cols] of Object.entries(plan.subject))
    stmts.push(
      d1
        .prepare(
          `DELETE FROM ${ident(table)} WHERE ${cols.map(c => `${ident(c)} = ?1`).join(' OR ')}`
        )
        .bind(s.userId)
    );
  for (const [table, cols] of Object.entries(plan.actor))
    for (const [col, replacement] of Object.entries(cols))
      stmts.push(
        d1
          .prepare(`UPDATE ${ident(table)} SET ${ident(col)} = ?2 WHERE ${ident(col)} = ?1`)
          .bind(s.userId, replacement)
      );
  if (s.email) {
    stmts.push(
      d1
        .prepare(
          `UPDATE ${ident(INVITE_TABLE)} SET status = CASE WHEN status = 'pending' THEN 'revoked' ELSE status END, decided_at = CASE WHEN status = 'pending' THEN ?2 ELSE decided_at END, email = 'erased-' || id || '@anonymized.invalid' WHERE lower(email) = lower(?1)`
        )
        .bind(s.email, now)
    );
  }
  const res = await d1.batch(stmts);
  const left = await countPlatformSubject(d1, s, plan);
  if (left !== 0) throw new Error(`platform erasure incomplete: ${left} row(s) remain`);
  return { changed: res.reduce((n, r) => n + Number(r?.meta?.changes ?? 0), 0) };
}

/**
 * STORE-scoped platform rows that hold people (Ruling FOLD-ERASURE-2), handled when a store is DELETED. Hand-listed because the
 * classification is keyed by user, not by store; `tests/unit/platform-subject-coverage.test.ts` fails when a store-keyed D1 table that
 * the classification calls personal is neither here nor on its allowlist.
 *   store_staff, merchant_api_keys   deleted (membership and credentials of a store that no longer exists)
 *   staff_invites                    revoked, invitee address overwritten
 *   store_subscriptions              billing record kept; the card reference and the provider customer id removed
 * Payer fields on instapay_receipts / manual_payment_claims are the payments erasure port's job (services/billing/payments-erasure.ts).
 */
// wa-plan: not-plan-state (the store_subscriptions UPDATE below clears only the card reference + provider customer id)
export const STORE_SCOPED_TABLES = [
  'store_staff',
  'merchant_api_keys',
  'staff_invites',
  'store_subscriptions',
] as const;

export async function eraseStorePlatformData(
  d1: D1Like,
  storeId: string,
  now: number = Date.now()
): Promise<void> {
  await d1.batch([
    d1.prepare('DELETE FROM "store_staff" WHERE "store_id" = ?1').bind(storeId),
    d1.prepare('DELETE FROM "merchant_api_keys" WHERE "store_id" = ?1').bind(storeId),
    d1
      .prepare(
        `UPDATE "staff_invites" SET status = CASE WHEN status = 'pending' THEN 'revoked' ELSE status END, decided_at = CASE WHEN status = 'pending' THEN ?2 ELSE decided_at END, email = 'erased-' || id || '@anonymized.invalid' WHERE "store_id" = ?1`
      )
      .bind(storeId, now),
    d1
      .prepare(
        'UPDATE "store_subscriptions" SET "provider_customer_id" = NULL, "payment_method_last4" = NULL WHERE "store_id" = ?1'
      )
      .bind(storeId),
  ]);
  const left = await d1
    .prepare(
      `SELECT (SELECT count(*) FROM "store_staff" WHERE "store_id" = ?1)
            + (SELECT count(*) FROM "merchant_api_keys" WHERE "store_id" = ?1)
            + (SELECT count(*) FROM "staff_invites" WHERE "store_id" = ?1 AND email NOT LIKE 'erased-%@anonymized.invalid')
            + (SELECT count(*) FROM "store_subscriptions" WHERE "store_id" = ?1 AND ("provider_customer_id" IS NOT NULL OR "payment_method_last4" IS NOT NULL)) AS n`
    )
    .bind(storeId)
    .first<{ n: number }>();
  if (Number(left?.n ?? 0) !== 0)
    throw new Error(`store platform erasure incomplete: ${left?.n} row(s) remain`);
}
