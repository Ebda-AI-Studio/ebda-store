/**
 * Ruling QA98-ALIAS-2: SMS consent is keyed on the recipient's full normalised phone (same number = same consent). The guest
 * grouping (built from unverified order data) never reads or changes consent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = {
  id: string;
  storeId: string;
  customerKey: string;
  phoneKey: string;
  granted: boolean;
  revokedAt: Date | null;
};
const h = vi.hoisted(() => ({ rows: [] as unknown[], groupsLoaded: 0 }));

function match(r: Record<string, unknown>, w: Record<string, unknown>): boolean {
  return Object.entries(w).every(([k, v]) => {
    if (k === 'OR') return (v as Array<Record<string, unknown>>).some(o => match(r, o));
    return r[k] === v;
  });
}
const rows = () => h.rows as Row[];
const db = {
  smsMarketingConsent: {
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      rows().find(r => match(r as never, where)) ?? null,
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
  loadCustomerGroups: async () => {
    h.groupsLoaded += 1;
    throw new Error('consent must not load the guest groups');
  },
}));

import { SmsConsentService } from '@api/services/sms-consent.service';

const STORE = 's1';
const row = (customerKey: string, phoneKey: string, granted: boolean): Row => ({
  id: `${customerKey}-${phoneKey}`,
  storeId: STORE,
  customerKey,
  phoneKey,
  granted,
  revokedAt: granted ? null : new Date(),
});

beforeEach(() => {
  h.rows = [];
  h.groupsLoaded = 0;
});

describe('SMS consent is per phone, never per guest group', () => {
  it("an attacker who links their email to the victim's order cannot withdraw or alter the victim's consent (different phone)", async () => {
    h.rows = [
      row('victim@x.test', '201000000001', true),
      row('attacker@x.test', '201099999999', true),
    ];
    const n = await SmsConsentService.revoke(STORE, { phone: '01099999999' }, 'unsubscribe');
    expect(n).toBe(1);
    expect(rows().find(r => r.customerKey === 'victim@x.test')!.granted).toBe(true);
    expect(await SmsConsentService.findActiveForPhone(STORE, '01000000001')).not.toBeNull();
    expect(h.groupsLoaded).toBe(0);
  });

  it('a same-phone opt-out (any spelling of the number) still blocks every row of that number', async () => {
    h.rows = [row('a@x.test', '201000000001', true), row('b@x.test', '201000000001', true)];
    await SmsConsentService.revoke(STORE, { phone: '+20 100 000 0001' }, 'unsubscribe');
    expect(await SmsConsentService.findActiveForPhone(STORE, '01000000001')).toBeNull();
    expect(h.groupsLoaded).toBe(0);
  });

  it('a different country code is a different number: +965 and +91 numbers never share consent', async () => {
    h.rows = [row('k@x.test', '96512345678', true), row('i@x.test', '916512345678', true)];
    await SmsConsentService.revoke(STORE, { phone: '+91 6512345678' }, 'unsubscribe');
    expect(rows().find(r => r.customerKey === 'k@x.test')!.granted).toBe(true);
    expect(await SmsConsentService.findActiveForPhone(STORE, '+965 12345678')).not.toBeNull();
    expect(await SmsConsentService.findActiveForPhone(STORE, '+91 6512345678')).toBeNull();
  });
});
