/** Ruling BIZ-ALL-1: no merchant-facing gate copy calls a feature an "add-on" or tells the merchant to ask a super admin. */
import { describe, it, expect } from 'vitest';
import en from '../../apps/admin/src/i18n/messages/en.json';
import ar from '../../apps/admin/src/i18n/messages/ar.json';

const BAD = /add-?on|premium|super admin|مسؤول عام|إضافة مميزة/i;
describe('merchant gate copy', () => {
  for (const [name, msgs] of [
    ['en', en],
    ['ar', ar],
  ] as const) {
    it(`${name}: featureUpgrade + floatingWidget namespaces never say add-on`, () => {
      const m = msgs as any;
      const text = JSON.stringify([m.featureUpgrade, m.floatingWidget]);
      expect(text).not.toMatch(BAD);
    });
    it(`${name}: a lower plan is offered upgrade or a single feature; Business gets a support-only message`, () => {
      const f = (msgs as any).featureUpgrade;
      expect(f.availableOnOrBuyOne).toContain('{plan}');
      expect(f.addJustThisCta).toBeTruthy();
      expect(f.businessOffBody).toContain('{feature}');
      expect(f.businessOffBody).not.toContain('{plan}');
    });
  }
});
