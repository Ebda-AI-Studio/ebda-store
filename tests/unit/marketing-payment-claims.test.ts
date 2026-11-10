import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Iceberg audit #9 (Ruling ICEBERG-PAY-COPY-1): public payment copy matches day-1 reality.
 *  - COD and InstaPay work for every store from day one.
 *  - Cards/wallets (Paymob, Kashier, FawryPay) only with the MERCHANT'S OWN gateway account (their KYC, not Ebda's).
 *  - Ebda's own plan is paid by InstaPay transfer, confirmed by hand; no card billing for plans yet.
 */
const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');
const FILES = [
  'apps/marketing/src/lib/content.ts',
  'apps/marketing/src/lib/capabilities.ts',
  'apps/marketing/src/lib/compare.ts',
];

describe('marketing payment claims', () => {
  for (const f of FILES)
    it(`${f}: every sentence that sells Paymob/Kashier/FawryPay says it is the merchant's own account`, () => {
      const offenders = read(f)
        .split('\n')
        .filter(
          l => /Paymob|Kashier|FawryPay/.test(l) && !/name: '(Paymob|Kashier|FawryPay)'/.test(l)
        )
        .filter(l => !/own (Paymob|account)|حسابك/.test(l));
      expect(offenders).toEqual([]);
    });
});

describe('help: how a merchant pays for the plan', () => {
  it('en + ar plans-and-billing say InstaPay, confirmed by hand, and no card billing yet', () => {
    const en = read('apps/help/content/en/plans-and-billing.mdx');
    const ar = read('apps/help/content/ar/plans-and-billing.mdx');
    expect(en).toMatch(/pay Ebda AI Studio by InstaPay transfer/);
    expect(en).toMatch(/by card is not available yet/);
    expect(ar).toMatch(/بتحويل إنستا باي/);
    expect(ar).toMatch(/الدفع بالكارت للباقات مش متاح لسه/);
  });
});
