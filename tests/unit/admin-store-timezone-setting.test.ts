/**
 * `stores.timezone` decides which day a sale, expense and VAT period belongs to
 * (Ruling FRT-2) and used to be settable only by SQL (issue 2411). The Tax page
 * now has a card for it. Source-level, like the other admin page guards here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TAX = resolve(__dirname, '../../apps/admin/src/app/stores/[id]/tax');
const card = readFileSync(resolve(TAX, '_components/TaxTimeZoneCard.tsx'), 'utf8');
const page = readFileSync(resolve(TAX, 'page.tsx'), 'utf8');
const MSG = resolve(__dirname, '../../apps/admin/src/i18n/messages');

describe('the admin can set the store time zone (issue 2411)', () => {
  it('the Tax page mounts the card', () => {
    expect(page).toMatch(/<TaxTimeZoneCard storeId=\{storeId\} \/>/);
  });

  it('saves through PUT /stores/:id with the zone', () => {
    expect(card).toMatch(/apiPut\(`\/api\/v1\/stores\/\$\{storeId\}`, \{ timezone: next \}\)/);
  });

  it('refetches the cached store so the Reports pickers see the new zone', () => {
    expect(card).toMatch(/await refetch\(\)/);
  });

  it('rolls the picker back and says why when the API rejects the zone', () => {
    expect(card).toMatch(/setValue\(previous\)/);
    expect(card).toMatch(/toastError\(error\.message\)/);
  });

  it('keeps a saved zone that is not in the shortlist selectable', () => {
    expect(card).toMatch(/options\.unshift\(saved\)/);
  });

  for (const locale of ['en', 'ar']) {
    it(`${locale} has every tax.timeZone key the card reads`, () => {
      const tz = JSON.parse(readFileSync(resolve(MSG, `${locale}.json`), 'utf8')).tax.timeZone;
      for (const key of ['title', 'description', 'label', 'saved']) {
        expect(typeof tz[key], `${locale} tax.timeZone.${key}`).toBe('string');
        expect(tz[key].length).toBeGreaterThan(0);
      }
    });
  }

  // Issue 2431: `stores.timezone` is the ONE store zone, not a report-only knob. The storefront
  // reads it for checkout delivery-window cutoffs and for every date a customer sees, so the card
  // must say so (Ruling FRT-2). Owner decision 2026-10-03: one zone, honest copy.
  const SCOPE = {
    en: [/delivery-window/i, /checkout/i, /customers see/i, /VAT/],
    ar: [/التوصيل/, /الدفع/, /العملاء/, /القيمة المضافة/],
  } as const;
  for (const locale of ['en', 'ar'] as const) {
    it(`${locale} card copy names everything the zone governs, not only reports (issue 2431)`, () => {
      const tz = JSON.parse(readFileSync(resolve(MSG, `${locale}.json`), 'utf8')).tax.timeZone;
      for (const re of SCOPE[locale]) expect(tz.description, `${locale} ${re}`).toMatch(re);
      expect(tz.title).not.toMatch(/report|للتقارير/i);
    });
  }
});
