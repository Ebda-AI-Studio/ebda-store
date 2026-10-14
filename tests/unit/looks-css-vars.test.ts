import { describe, it, expect, vi } from 'vitest';
import { composeStoreTheme } from '@force/shared';

// StoreContext pulls React providers; only its exported pure mirror is needed.
vi.mock('../../apps/web/src/contexts/LanguageContext', () => ({ useLanguage: () => ({}) }));
import { themeToCssVars as clientVars } from '../../apps/web/src/contexts/StoreContext';
import { themeToCssVars as sharedVars } from '@force/shared';

describe('themeToCssVars parity (SSR shared vs client mirror)', () => {
  for (const [name, input] of [
    ['look theme', { template: 'minimal', look: 'souq.night', theme: {} }],
    ['legacy theme', { template: 'minimal', theme: {} }],
  ] as const) {
    it(`${name}: identical variable sets and values`, () => {
      const t = composeStoreTheme(input as Parameters<typeof composeStoreTheme>[0]);
      const lookId = (input as { look?: string }).look;
      expect(clientVars(t, lookId)).toEqual(sharedVars(t, lookId));
      if (lookId) expect(Object.keys(clientVars(t, lookId))).toContain('--font-latin');
    });
  }
});
