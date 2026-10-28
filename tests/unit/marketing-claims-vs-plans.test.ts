import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * P12 (M-079 / DOC-4, M-027 / BIZ-3): public claims must match the plan gates and the VAT ruling.
 *  - SMS cart recovery is Business-only and runs on the merchant's own SMS account (`sms` is an enterprise addition).
 *  - Prices are final amounts, no VAT (Ruling VAT-0): help, Terms and pricing say the same thing.
 */
const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

describe('marketing claims match the plan gates', () => {
  const caps = read('apps/marketing/src/lib/capabilities.ts');
  const compare = read('apps/marketing/src/lib/compare.ts');

  it('no cart-recovery claim puts SMS on Growth', () => {
    expect(caps).not.toMatch(/by email or by SMS/);
    expect(caps).not.toMatch(/by SMS when they agreed/);
    expect(caps).not.toMatch(/برسالة SMS لو العميل وافق/);
    expect(compare).not.toMatch(/notification or SMS/);
    expect(compare).not.toMatch(/بإشعار أو SMS/);
  });

  it("every SMS mention says Business plan and the merchant's own SMS account (ar and en)", () => {
    for (const text of [caps, compare]) {
      for (const m of text.matchAll(/[^\n]*\bSMS\b[^\n]*/g)) {
        const line = m[0];
        if (/^\s*\/\//.test(line)) continue;
        expect(line, line.slice(0, 80)).toMatch(/Business plan|باقة الأعمال/);
      }
    }
  });
});

describe('VAT-0: help says what the Terms say', () => {
  it('plans-and-billing (en, ar) states final amounts, no VAT charged, 30 days of notice, never retroactive', () => {
    const en = read('apps/help/content/en/plans-and-billing.mdx');
    const ar = read('apps/help/content/ar/plans-and-billing.mdx');
    expect(en).toContain('final amounts');
    expect(en).toContain('not registered for VAT');
    expect(en).toContain('30 days of written notice');
    expect(en).toContain('never applies retroactively');
    expect(ar).toContain('مبالغ نهائية');
    expect(ar).toContain('غير مسجّلة في ضريبة القيمة المضافة');
    expect(ar).toContain('30 يومًا');
    expect(ar).toContain('بأثر رجعي');
    expect(en + ar).not.toMatch(/14%|until Ebda AI Studio registers/);
  });
});
