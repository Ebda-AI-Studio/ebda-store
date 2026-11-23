/**
 * Rulings BIZ-ALL-1 + AI-ADDON-1: merchant-facing gate copy never tells the merchant to ask a super admin or calls a feature
 * "premium". The word "add-on" is allowed: single features ARE sold as add-ons (AI-ADDON-1, 2026-11-23).
 */
import { describe, it, expect } from 'vitest';
import en from '../../apps/admin/src/i18n/messages/en.json';
import ar from '../../apps/admin/src/i18n/messages/ar.json';

/** Merchant-facing text only: message VALUES, never key names (a key like `premiumSubtitle` is not copy). */
const values = (o: unknown): string[] =>
  typeof o === 'string' ? [o] : o && typeof o === 'object' ? Object.values(o).flatMap(values) : [];
const BAD = /premium|super admin|مسؤول عام|إضافة مميزة/i;
describe('merchant gate copy', () => {
  for (const [name, msgs] of [
    ['en', en],
    ['ar', ar],
  ] as const) {
    it(`${name}: featureUpgrade + floatingWidget namespaces never say premium or super admin`, () => {
      const m = msgs as any;
      const text = values([m.featureUpgrade, m.floatingWidget]).join('\n');
      expect(text).not.toMatch(BAD);
    });
    it(`${name}: a lower plan is offered upgrade or a single feature; Business gets a support-only message`, () => {
      const f = (msgs as any).featureUpgrade;
      expect(f.availableOnOrBuyOne).toContain('{plan}');
      expect(f.addJustThisCta).toBeTruthy();
      expect(f.businessOffBody).toContain('{feature}');
      expect(f.businessOffBody).toContain('{plan}'); // plan name comes from the plan-label source, never typed
    });
  }
});
