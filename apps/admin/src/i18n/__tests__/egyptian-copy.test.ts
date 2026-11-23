import { describe, expect, it } from 'vitest';
import ar from '../messages/ar.json';

const get = (key: string): string => {
  const v = key
    .split('.')
    .reduce<unknown>((o, p) => (o as Record<string, unknown> | undefined)?.[p], ar);
  if (typeof v !== 'string') throw new Error(`missing ar key ${key}`);
  return v;
};

// Live QA 2026-11-17 (K2/C2/C3/S2): rows that shipped as formal MSA. Each must stay Egyptian.
const MSA = /الذين|اللذين|لا تحتاج|سيصل|ستحتاج|انقر|إذا |لماذا|كحد أقصى|يمكن |لن تُ|لم يُ|ضمن/;
const K2_KEYS = [
  'customers.page.subtitle',
  'billing.subtitle',
  'billing.instapay.qrHint',
  'domain.page.wwwAutoAttachedMessage',
  'pwa.benefits.title',
  'pwa.benefits.install.description',
  'components.imageUpload.browse',
  'account.security.disableDescription',
  'account.security.passkeys.description',
  'products.edit.fields.searchTermsHint',
  'staff.page.subtitle',
];

describe('admin AR copy is Egyptian (QA 2026-11-17)', () => {
  it.each(K2_KEYS)('%s has no formal-MSA markers', key => {
    expect(get(key)).not.toMatch(MSA);
  });

  it('C2: product media hint states one ratio (3:4), no contradicting 1000×1000', () => {
    for (const k of ['products.edit.fields.mediaSizeHint', 'products.new.fields.mediaSizeHint']) {
      expect(get(k)).toContain('3:4');
      expect(get(k)).not.toMatch(/1000\s*×\s*1000/);
    }
  });

  it('C3: per-field AI button is an action label', () => {
    expect(get('products.aiFieldBadge.switchToAiLabel')).not.toContain('التحويل');
  });

  it('S2: SEO answer-engine placeholder is not a bare English sentence', () => {
    expect(get('seo.page.aeoPlaceholderEn')).toMatch(/[؀-ۿ]/);
  });
});
