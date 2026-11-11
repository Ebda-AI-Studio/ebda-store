import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CONSENT_UI,
  CONSENT_BAR_MAX_VIEWPORT_SHARE,
} from '../../packages/shared/src/tracking/consent-ui';

/** COOKIE-UI-1: the store bar and the marketing bar take their words from one file and keep the same controls. */
describe('cookie bar: one source (COOKIE-UI-1)', () => {
  const store = readFileSync('apps/web/src/components/CookieConsentBanner.tsx', 'utf8');
  const marketing = readFileSync('packages/shared/src/tracking/browser.ts', 'utf8');
  it('both surfaces read CONSENT_UI', () => {
    expect(store).toContain('CONSENT_UI');
    expect(marketing).toContain('CONSENT_UI');
  });
  it('Arabic words are the agreed ones and the height budget is 12%', () => {
    expect(CONSENT_UI.ar.reject).toBe('رفض الكل');
    expect(CONSENT_UI.ar.accept).toBe('قبول');
    expect(CONSENT_UI.ar.customize).toBe('تخصيص');
    expect(CONSENT_BAR_MAX_VIEWPORT_SHARE).toBe(0.12);
  });
  it('the store renders Reject and Accept with the identical class list; Customize is not a filled button', () => {
    const fills =
      store.match(/\$\{CONSENT_BTN\} bg-foreground text-background hover:bg-foreground\/90/g) ?? [];
    expect(fills).toHaveLength(2);
    expect(store).toMatch(/data-consent="customize"[\s\S]{0,200}underline/);
  });
});
