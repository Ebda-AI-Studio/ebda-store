import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ar from '../../apps/admin/src/i18n/messages/ar.json';
import en from '../../apps/admin/src/i18n/messages/en.json';

const read = (p: string) => readFileSync(p, 'utf8');

describe('STORE-QA-8 order list Arabic names: one PK query, two columns, no join', () => {
  it('productArabicNames issues exactly one findMany selecting only id + nameAr', async () => {
    vi.mock('@ebda/database', async importOriginal => ({ ...(await importOriginal<object>()) }));
    const { productArabicNames } = await import('../../apps/api/src/services/order.service');
    const findMany = vi.fn(async () => [
      { id: 'p1', nameAr: 'خاتم' },
      { id: 'p2', nameAr: null },
    ]);
    const m = await productArabicNames({ product: { findMany } }, 's1', [
      'p1',
      'p1',
      'p2',
      null,
      undefined,
    ]);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: { storeId: 's1', id: { in: ['p1', 'p2'] } },
      select: { id: true, nameAr: true },
    });
    expect([...m]).toEqual([['p1', 'خاتم']]);
    const none = vi.fn();
    await productArabicNames({ product: { findMany: none } }, 's1', [null]);
    expect(none).not.toHaveBeenCalled();
  });
});

describe('STORE-QA-67 receipts', () => {
  it('an unpaid COD document prints as an order confirmation, Arabic prints ج.م', () => {
    const src = read('apps/api/src/services/invoice.service.ts');
    expect(src).toContain("orderConfirmation: 'Order confirmation'");
    expect(src).toContain("orderConfirmation: 'تأكيد الطلب'");
    expect(src).toContain('emailMoney(minor, currency, lang)');
    expect(src).toContain('emailMoney(minor, currency, lang)');
  });
});

describe('STORE-QA-26/32 one script per locale, no jargon', () => {
  it('no provider/protocol jargon in merchant copy, Arabic carriers in Arabic, one on/off wording', () => {
    const blob = JSON.stringify(ar) + JSON.stringify(en);
    for (const bad of ['Unifonic', 'VAPID', 'W3C Push']) expect(blob).not.toContain(bad);
    expect(JSON.stringify(ar)).not.toContain('فريق إبدا');
    expect(ar.paymentSettings.toggle.disabled).toBe(ar.paymentSettings.strip.off);
    expect(en.paymentSettings.toggle.disabled).toBe(en.paymentSettings.strip.off);
    const card = read(
      'apps/admin/src/app/stores/[id]/payment-settings/_components/ProviderCard.tsx'
    );
    expect(card).not.toContain("lang={isAr ? 'en' : 'ar'}");
  });
});

describe('STORE-QA-20 icon-only controls carry a name', () => {
  it('no <button>/<Button> whose only child is an <svg> lacks aria-label/title', () => {
    const ROOT = join(__dirname, '../../apps/admin/src');
    const walk = (d: string, out: string[] = []): string[] => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) n !== 'node_modules' && walk(p, out);
        else if (/\.tsx$/.test(n) && !/\.test\./.test(n)) out.push(p);
      }
      return out;
    };
    const hits: string[] = [];
    for (const f of walk(ROOT)) {
      const s = read(f);
      for (const m of s.matchAll(
        /<(button|Button)\b((?:[^<>]|=>)*?)>\s*<svg\b(?:(?!<\/svg>)[\s\S])*<\/svg>\s*<\/\1>/g
      )) {
        if (!/aria-label|aria-labelledby|title=/.test(m[2])) hits.push(f.replace(ROOT, ''));
      }
    }
    expect(hits).toEqual([]);
  });
});
