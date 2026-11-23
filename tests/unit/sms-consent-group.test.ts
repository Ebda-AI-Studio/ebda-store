/**
 * Ruling QA98-ALIAS-1, consent: the customer is the whole guest group. Any opt-out among its keys or phones means NOBODY in the
 * group is texted, and an opt-out recorded through any member applies to the group.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomerGroups } from '@api/lib/customer-groups';

type Row = {
  id: string;
  storeId: string;
  customerKey: string;
  phoneKey: string;
  granted: boolean;
  revokedAt: Date | null;
  updatedAt: Date;
  grantedAt: Date | null;
};
const h = vi.hoisted(() => ({ rows: [] as unknown[] }));

/** Tiny evaluator for exactly the `where` shapes the service builds. */
function match(r: Record<string, unknown>, w: Record<string, unknown>): boolean {
  return Object.entries(w).every(([k, v]) => {
    if (k === 'OR') return (v as Array<Record<string, unknown>>).some(o => match(r, o));
    if (v && typeof v === 'object' && 'in' in (v as object))
      return (v as { in: unknown[] }).in.includes(r[k]);
    if (v && typeof v === 'object' && 'not' in (v as object))
      return r[k] !== (v as { not: unknown }).not;
    return r[k] === v;
  });
}
const rows = () => h.rows as Row[];
const db = {
  smsMarketingConsent: {
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      rows().find(r => match(r as never, where)) ?? null,
    findMany: async ({ where }: { where: Record<string, unknown> }) =>
      rows().filter(r => match(r as never, where)),
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
      const hit = rows().filter(r => match(r as never, where));
      hit.forEach(r => Object.assign(r, data));
      return { count: hit.length };
    },
  },
};
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: async () => db,
  storeRepo: async () => ({ backend: 'do' }),
  storeWriter: async () => db,
}));
vi.mock('@ebda/database', () => ({ prisma: {} }));
vi.mock('@api/lib/customer-groups-store', () => ({
  loadCustomerGroups: async () =>
    new CustomerGroups([
      { key: '+20 100 000 0001', email: '', phone: '+20 100 000 0001' }, // guest A: phone only
      { key: 'b@x.test', email: 'b@x.test', phone: '01000000001' }, // guest B: same phone + an email
      { key: 'b@x.test', email: 'b@x.test', phone: '01000000002' }, // B's second phone
      { key: 'other@x.test', email: 'other@x.test', phone: '01099999999' },
    ]),
}));

import { SmsConsentService } from '@api/services/sms-consent.service';

const STORE = 's1';
const T = new Date('2026-11-01T00:00:00Z');
const row = (customerKey: string, phoneKey: string, granted: boolean): Row => ({
  id: `${customerKey}-${phoneKey}`,
  storeId: STORE,
  customerKey,
  phoneKey,
  granted,
  revokedAt: granted ? null : T,
  updatedAt: T,
  grantedAt: granted ? T : null,
});

beforeEach(() => {
  h.rows = [];
});

describe('promotional SMS gate over a guest group', () => {
  it('A (phone) opted out, B (same phone + email) opted in: the group is NOT texted', async () => {
    h.rows = [
      row('+20 100 000 0001', '201000000001', false),
      row('b@x.test', '201000000001', true),
    ];
    expect(await SmsConsentService.findActiveForPhone(STORE, '01000000001')).toBeNull();
    // the group's other phone is covered too (same email links it)
    h.rows.push(row('b@x.test|2', '201000000002', true));
    expect(await SmsConsentService.findActiveForPhone(STORE, '01000000002')).toBeNull();
  });

  it('texts only when someone granted and nobody in the group opted out', async () => {
    h.rows = [row('b@x.test', '201000000001', true)];
    expect(await SmsConsentService.findActiveForPhone(STORE, '01000000001')).toMatchObject({
      id: 'b@x.test-201000000001',
    });
    // another person's opt-out does not touch this group
    h.rows.push(row('other@x.test', '201099999999', false));
    expect(await SmsConsentService.findActiveForPhone(STORE, '01000000001')).not.toBeNull();
  });

  it('an opt-out through any member (one phone) withdraws every granted row of the group', async () => {
    h.rows = [
      row('b@x.test', '201000000001', true),
      row('b@x.test|2', '201000000002', true),
      row('other@x.test', '201099999999', true),
    ];
    const n = await SmsConsentService.revoke(STORE, { phone: '01000000002' }, 'unsubscribe');
    expect(n).toBe(2);
    expect(rows().find(r => r.customerKey === 'other@x.test')!.granted).toBe(true);
    expect(await SmsConsentService.findActiveForPhone(STORE, '01000000001')).toBeNull();
  });

  it('the surfaces show the group as withdrawn when any member withdrew', async () => {
    h.rows = [
      row('+20 100 000 0001', '201000000001', false),
      row('b@x.test', '201000000001', true),
    ];
    const group = (await import('@api/lib/customer-groups-store'))
      .loadCustomerGroups as () => Promise<CustomerGroups>;
    const g = (await group()).groupOfMemberKey('b@x.test')!;
    const view = await SmsConsentService.getForCustomerKey(STORE, g.key, '01000000001', g);
    expect(view.status).toBe('revoked');
    const list = await SmsConsentService.statusForKeys(STORE, [
      { key: g.key, phone: '01000000001', group: g },
    ]);
    expect(list.get(g.key)).toBe('revoked');
  });
});
