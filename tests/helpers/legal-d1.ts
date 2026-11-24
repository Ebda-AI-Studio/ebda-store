/**
 * Fixtures for the legal-notice suites on the platform D1 (tests/unit/legal-*-on-d1.test.ts): the identity service's accounts
 * (a Map the mocked `getAccountState` / `getAccountsBrief` answer from), and raw inserts into the platform D1 tables the
 * services read through the platform router (`legal_notice_sends`, `legal_notice_deliveries`, `legal_acceptances`, `stores`).
 */
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { LEGAL_POLICIES, type LegalPolicies } from '@ebda/shared';

export type Role = 'store_admin' | 'super_admin' | 'staff';
export const V = '99.0';
export const accounts = new Map<
  string,
  { role: Role; email: string; firstName: string; language: string }
>();

export function mkUser(tag: string, role: Role, language = 'ar'): string {
  const id = crypto.randomUUID();
  accounts.set(id, {
    role,
    email: `${tag}-${id.slice(0, 6)}@test.local`,
    firstName: 'Lg',
    language,
  });
  return id;
}

/** terms@99.0: a material fee change published today, effective `effectiveInDays` from now. */
const DAY = 86_400_000;
const isoDay = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
export const fixture = (effectiveInDays = 40, feeChange = true): LegalPolicies => ({
  ...LEGAL_POLICIES,
  terms: {
    history: [
      ...LEGAL_POLICIES.terms.history,
      {
        version: V,
        publishedAt: isoDay(0),
        effectiveAt: isoDay(effectiveInDays),
        material: true,
        feeChange,
        summary: { ar: 'تغيير تجريبي في الرسوم.', en: 'Test fee change.' },
      },
    ],
  },
});

export const insSend = (
  d1: DatabaseSync,
  docKey: string,
  version: string,
  sentBy: string,
  recipientCount: number | null = null
): string => {
  const id = crypto.randomUUID();
  d1.prepare(
    `INSERT INTO legal_notice_sends (id, doc_key, version, sent_by, recipient_count) VALUES (?, ?, ?, ?, ?)`
  ).run(id, docKey, version, sentBy, recipientCount);
  return id;
};
export const insDelivery = (
  d1: DatabaseSync,
  userId: string,
  status: 'queued' | 'sending' | 'sent' | 'failed' = 'queued',
  error: string | null = null,
  docKey = 'terms',
  version = V
): void => {
  d1.prepare(
    `INSERT INTO legal_notice_deliveries (id, user_id, doc_key, version, status, error) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(crypto.randomUUID(), userId, docKey, version, status, error);
};
export const insAcceptance = (
  d1: DatabaseSync,
  userId: string,
  docKey: string,
  version: string,
  source: 'signup' | 'notice_ack' = 'signup',
  ip: string | null = null,
  userAgent: string | null = null
): void => {
  d1.prepare(
    `INSERT INTO legal_acceptances (id, user_id, doc_key, version, source, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(crypto.randomUUID(), userId, docKey, version, source, ip, userAgent);
};
export const insStore = (
  d1: DatabaseSync,
  ownerId: string,
  n: number,
  opts: { deleted?: boolean; demo?: boolean } = {}
): string => {
  const id = crypto.randomUUID();
  d1.prepare(
    `INSERT INTO stores (id, name, slug, owner_id, status, deleted_at, is_demo) VALUES (?, ?, ?, ?, 'active', ?, ?)`
  ).run(
    id,
    `lg-${n}`,
    `lg-${n}-${id.slice(0, 6)}`,
    ownerId,
    opts.deleted ? Date.now() : null,
    opts.demo ? 1 : 0
  );
  return id;
};
export const rows = (d1: DatabaseSync, sql: string, ...p: unknown[]) =>
  d1.prepare(sql).all(...(p as never[])) as Array<Record<string, any>>;
export const count = (d1: DatabaseSync, sql: string, ...p: unknown[]): number =>
  Number((d1.prepare(sql).get(...(p as never[])) as { n: number }).n);
