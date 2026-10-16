/**
 * S-01 follow-up (W1c review I3 + M7): the footer legal row's settings
 * (`settings.footerLinks.bottomBar`) have a UI, are validated at the API edge,
 * survive every save path, and the Returns link follows the returns feature.
 *
 *  - The admin footer editor rebuilt `footerLinks` on save and dropped `bottomBar`,
 *    so any toggle (or © override) was wiped by the next footer save. It now
 *    merges key by key over what is stored (`mergeFooterLinksForSave`).
 *  - The page-builder publish (`applyChromePatch`) carries and merges it too.
 *  - Every settings write runs `footerBottomBarSchema` (store.routes).
 *  - The admin editor shows the toggles + © override, in ar and en.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@ebda/database', () => ({
  prisma: {},
  Prisma: {},
  withMoneyTx: vi.fn(),
  withStore: vi.fn(),
  acrossStores: vi.fn(),
}));
vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: { delete: vi.fn(), get: vi.fn(), set: vi.fn(), getClient: vi.fn(() => null) },
}));
vi.mock('../../apps/api/src/lib/public-cache', () => ({
  invalidateCached: vi.fn(),
  invalidateCachedPrefix: vi.fn(),
  memoryCache: { get: vi.fn(), set: vi.fn() },
}));
vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock('../../apps/api/src/services/r2-cleanup.service', () => ({
  cleanupRemovedImages: vi.fn(),
  deleteR2ObjectIfOrphan: vi.fn(),
}));
vi.mock('../../apps/api/src/services/accounting/account.service', () => ({
  seedCoaForStore: vi.fn(),
}));

import { updateStoreSchema, createStoreSchema } from '../../apps/api/src/routes/store.routes';
import { applyChromePatch, draftChromeSchema, footerBottomBarSchema } from '@ebda/shared';
import { mergeFooterLinksForSave } from '../../apps/admin/src/components/FooterLinksEditor';
import { footerDisabledSlugs } from '../../apps/web/src/components/ShopChrome';
import { resolveBottomBar } from '../../apps/web/src/templates/shared/display-helpers';

const ROOT = join(__dirname, '../..');
const cols = { shop: [], support: [], company: [], newsletterEnabled: true };

describe('FU46 M-7: legacy © values read safely', () => {
  it('null is unset (default line), an over-long override is clamped to 200', () => {
    const nul = { copyrightOverride: null } as never;
    expect(resolveBottomBar(nul, 'Shop', false, undefined, 2026).copyright).toBe(
      '© 2026 Shop. All rights reserved.'
    );
    const long = { copyrightOverride: 'y'.repeat(300) } as never;
    expect(resolveBottomBar(long, 'Shop', false, undefined, 2026).copyright).toBe('y'.repeat(200));
  });
});

describe('FU46 M-9: the default © line with no store name', () => {
  it('has no stray " ." (en and ar), and a blank name counts as none', () => {
    expect(resolveBottomBar(undefined, '', false, undefined, 2026).copyright).toBe(
      '© 2026 · All rights reserved.'
    );
    expect(resolveBottomBar(undefined, '  ', true, undefined, 2026).copyright).toBe(
      '© 2026 · جميع الحقوق محفوظة.'
    );
    expect(resolveBottomBar(undefined, 'Shop', false, undefined, 2026).copyright).toBe(
      '© 2026 Shop. All rights reserved.'
    );
  });
});

describe('the admin footer save never drops the legal row settings', () => {
  it('keeps every stored bottom-bar key the editor did not change (the 2026-05 wipe)', () => {
    const stored = {
      ...cols,
      bottomBar: { returnsEnabled: false, copyrightOverride: '© Shop', legacy: 1 },
      somethingElse: 'kept',
    };
    const out = mergeFooterLinksForSave(stored as never, { ...cols, bottomBar: {} });
    expect(out.bottomBar).toEqual({
      returnsEnabled: false,
      copyrightOverride: '© Shop',
      legacy: 1,
    });
    expect((out as Record<string, unknown>).somethingElse).toBe('kept');
  });

  it('lays the edited keys over the stored ones', () => {
    const out = mergeFooterLinksForSave(
      { ...cols, bottomBar: { returnsEnabled: false, termsEnabled: true } } as never,
      { ...cols, bottomBar: { termsEnabled: false } }
    );
    expect(out.bottomBar).toEqual({ returnsEnabled: false, termsEnabled: false });
  });

  it('the page-builder publish merges a bottom-bar patch the same way', () => {
    const live = { footerLinks: { bottomBar: { returnsEnabled: false, copyrightOverride: 'x' } } };
    const patch = draftChromeSchema.parse({
      footerLinks: { bottomBar: { privacyEnabled: false } },
    });
    const out = applyChromePatch(live, patch) as { footerLinks: { bottomBar: unknown } };
    expect(out.footerLinks.bottomBar).toEqual({
      returnsEnabled: false,
      copyrightOverride: 'x',
      privacyEnabled: false,
    });
    // and a patch without bottomBar leaves it untouched
    const out2 = applyChromePatch(live, draftChromeSchema.parse({ footerLinks: { shop: [] } })) as {
      footerLinks: { bottomBar: unknown };
    };
    expect(out2.footerLinks.bottomBar).toEqual(live.footerLinks.bottomBar);
  });
});

describe('the API edge validates the legal row settings', () => {
  const body = (bottomBar: unknown) => ({ settings: { footerLinks: { bottomBar } } });
  for (const [name, schema] of [
    ['update', updateStoreSchema],
    ['create', createStoreSchema],
  ] as const) {
    it(`${name}: accepts the toggles and the © override`, () => {
      const ok = { returnsEnabled: false, privacyEnabled: true, copyrightOverrideAr: '© متجر' };
      expect(schema.safeParse({ name: 'Shop', ...body(ok) }).success).toBe(true);
    });
    it(`${name}: refuses a non-boolean toggle`, () => {
      expect(schema.safeParse({ name: 'Shop', ...body({ returnsEnabled: 'no' }) }).success).toBe(
        false
      );
    });
    it(`${name}: a legacy null or over-long © never blocks the save (FU46 M-7)`, () => {
      for (const legacy of [
        { copyrightOverride: null },
        { copyrightOverrideAr: null, privacyEnabled: false },
        { copyrightOverride: 'x'.repeat(300) },
      ]) {
        expect(schema.safeParse({ name: 'Shop', ...body(legacy) }).success).toBe(true);
      }
    });
  }
  it('the schema is the shared one', () => {
    expect(footerBottomBarSchema.safeParse({ returnsEnabled: true }).success).toBe(true);
  });
});

describe('the admin editor shows the legal row (every data has a UI)', () => {
  const src = readFileSync(join(ROOT, 'apps/admin/src/components/FooterLinksEditor.tsx'), 'utf8');
  const keys = [
    'legalRow',
    'legalRowHint',
    'legalRowWhere',
    'legalRowPrivacy',
    'legalRowTerms',
    'legalRowReturns',
    'legalRowCopyrightPlaceholder',
    'legalRowCopyrightArPlaceholder',
  ];
  it('renders the switch, the three link toggles and the two © inputs', () => {
    for (const k of ['privacyEnabled', 'termsEnabled', 'returnsEnabled', 'copyrightOverrideAr'])
      expect(src).toContain(k);
    for (const k of keys) expect(src).toContain(`'${k}'`);
  });
  for (const lang of ['en', 'ar'])
    it(`${lang} messages carry every legal-row key`, () => {
      const msgs = JSON.parse(
        readFileSync(join(ROOT, `apps/admin/src/i18n/messages/${lang}.json`), 'utf8')
      );
      for (const k of keys) expect(msgs.pages.page[k], k).toBeTruthy();
    });
});

describe("the Returns link follows the store's returns feature (review M7)", () => {
  it('feature off → the returns link is off', () => {
    const slugs = footerDisabledSlugs(['privacy'], ['coupons']);
    expect(slugs).toEqual(['privacy', 'returns']);
    expect(resolveBottomBar(undefined, 'Shop', false, slugs, 2026).returnsEnabled).toBe(false);
  });
  it('feature on, or features unknown → unchanged', () => {
    expect(footerDisabledSlugs(['privacy'], ['returns'])).toEqual(['privacy']);
    expect(footerDisabledSlugs(undefined, undefined)).toBeUndefined();
  });
});
