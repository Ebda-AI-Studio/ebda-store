/**
 * MFA key rotation (pre-launch requirement): sealed TOTP secrets name their key (`v2.<kid>...`), a small keyring (`MFA_KEY` current,
 * `MFA_KEY_PREV` previous) opens them, and this job re-seals every secret that is not on the current key. It is compare-and-set
 * per row, so a user enrolling or disabling MFA while it runs is never overwritten, and it can run any number of times.
 *
 * Rotation: (1) MFA_KEY_PREV <- the old key, MFA_KEY <- the new key, (2) wait for the job (hourly cron, or `Accounts.reencryptMfa`)
 * to report `remaining: 0`, (3) remove MFA_KEY_PREV.
 */
import { needsReseal, sealCurrent, unsealAny, keyId, type MfaKeyring } from './totp';

export interface ReencryptReport {
  scanned: number;
  resealed: number;
  /** Row changed under us (CAS lost) or could not be opened: left untouched, picked up by the next run. */
  skipped: number;
  failed: number;
  /** Secrets still not on the current key after this run. */
  remaining: number;
}

export async function reencryptMfaSecrets(
  env: MfaKeyring & { DB: D1Database },
  limit = 200
): Promise<ReencryptReport> {
  const report: ReencryptReport = { scanned: 0, resealed: 0, skipped: 0, failed: 0, remaining: 0 };
  if (!env.MFA_KEY) return report;
  const current = `v2.${await keyId(env.MFA_KEY)}.%`;
  // Paged by id so a row that can never be opened is stepped over (not re-picked forever) and cannot starve the rest.
  let after = '';
  while (report.scanned < limit) {
    const rows = await env.DB.prepare(
      `SELECT id, mfa_secret FROM users WHERE mfa_secret IS NOT NULL AND mfa_secret NOT LIKE ?1 AND id > ?2 ORDER BY id LIMIT ?3`
    )
      .bind(current, after, Math.min(100, limit - report.scanned))
      .all<{ id: string; mfa_secret: string }>();
    if (rows.results.length === 0) break;
    for (const row of rows.results) {
      after = row.id;
      report.scanned++;
      try {
        if (!(await needsReseal(env, row.mfa_secret))) continue;
        const next = await sealCurrent(env, await unsealAny(env, row.mfa_secret, row.id), row.id);
        const r = await env.DB.prepare(
          `UPDATE users SET mfa_secret = ?3 WHERE id = ?1 AND mfa_secret = ?2`
        )
          .bind(row.id, row.mfa_secret, next)
          .run();
        if ((r.meta.changes ?? 0) === 1) report.resealed++;
        else report.skipped++;
      } catch (e) {
        report.failed++;
        console.error(
          JSON.stringify({ msg: 'mfa reseal failed', userId: row.id, error: (e as Error).message })
        );
      }
    }
  }
  const left = await env.DB.prepare(
    `SELECT count(*) AS n FROM users WHERE mfa_secret IS NOT NULL AND mfa_secret NOT LIKE ?1`
  )
    .bind(current)
    .first<{ n: number }>();
  report.remaining = left?.n ?? 0;
  return report;
}
