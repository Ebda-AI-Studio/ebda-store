/**
 * QA-CART-1 / QA-COPY-2: the abandoned-carts page said "one reminder per cart" above settings for THREE reminder
 * steps. Both are true: the EMAIL is one per cart, the step reminders (SMS / push) are up to 3. The banner now says so,
 * and these tests pin copy to behaviour. QA-COPY-2: no MSA markers left in the marketing sections' Arabic.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import en from '../../apps/admin/src/i18n/messages/en.json';
import ar from '../../apps/admin/src/i18n/messages/ar.json';

const read = (p: string) => readFileSync(path.resolve(__dirname, '../../', p), 'utf8');

describe('abandoned carts: copy matches what the sender does', () => {
  it('the step reminders stop at 3 (the settings form has exactly 3 steps)', () => {
    const svc = read('apps/api/src/services/abandoned-cart.service.ts');
    expect(svc).toContain('for (let s = fromStep; s <= 3; s++)');
    expect(svc).not.toMatch(/case 4:/);
    const form = read(
      'apps/admin/src/app/stores/[id]/abandoned-carts/_components/RecoveryCampaignForm.tsx'
    );
    expect(form).toContain('step3Enabled');
    expect(form).not.toContain('step4Enabled');
  });

  it('the email goes out once per cart: only a claimed (queued) row is mailed', () => {
    const svc = read('apps/api/src/services/cart-recovery-email.service.ts');
    expect(svc).toContain("loaded.ac.emailStatus !== 'queued'");
  });

  it('the banner says one EMAIL per cart and that the steps (up to 3) are separate, in both languages', () => {
    const nudge = (m: unknown) => (m as any).abandonedCarts.emailNudge.body as string;
    expect(nudge(en)).toMatch(/One email per cart/);
    expect(nudge(en)).toMatch(/up to 3 reminders/);
    expect(nudge(ar)).toContain('بريد واحد');
    expect(nudge(ar)).toContain('3 تذكيرات');
  });
});

describe('QA-COPY-2: Egyptian, not MSA, in the marketing sections', () => {
  const MSA = /سيصل|سيتم|سوف |الذين|يمكن إرسال|تُرسل|لم تُرسل|يصله|استعادة المبيعات المفقودة/;
  for (const ns of ['campaigns', 'newsletter', 'abandonedCarts'] as const) {
    it(`${ns}: no MSA marker in any Arabic string`, () => {
      const hits: string[] = [];
      const walk = (o: unknown, p: string) => {
        if (o && typeof o === 'object')
          for (const [k, v] of Object.entries(o)) walk(v, `${p}.${k}`);
        else if (typeof o === 'string' && MSA.test(o)) hits.push(`${p}: ${o}`);
      };
      walk((ar as any)[ns], ns);
      expect(hits).toEqual([]);
    });
  }
  it('the two sentences from the live QA read as Egyptian full sentences', () => {
    const c = (ar as any).campaigns;
    expect(c.list.audienceCount).toBe('الحملة هتوصل لـ {count} شخص');
    expect(c.list.audienceRemaining).toBe('تقدر تبعت {remaining} من {cap} في الـ 24 ساعة الجاية');
  });
});
