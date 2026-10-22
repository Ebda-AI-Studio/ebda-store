// Phase B5 Task 4 (Ruling B5-3): a store that is still on the retired Dahab skin
// (`template = 'dahab'`, `look = null`) must be safe by construction, and the migration script that
// moves it must be dry-run by default, loopback-only without an explicit production flag, and
// idempotent by selection.
import { describe, it, expect } from 'vitest';
import {
  composeStoreTheme,
  getTemplateTheme,
  themeToCssVars,
  LOOK_OWNED_THEME_KEYS,
} from '@ebda/shared';
import {
  keepDiff,
  parseArgs,
  main,
  DEFAULT_LOOK,
} from '../../scripts/dahab-demo/migrate-legacy-dahab.mjs';
import { guard } from '../../scripts/storedemo/seed.mjs';

describe('a template=dahab, look=null row renders the neutral base', () => {
  const theme = composeStoreTheme({ template: 'dahab', look: null, theme: null });
  it('is a white page with an ink primary: no night, no gold', () => {
    expect(theme.backgroundColor).toBe('0 0% 100%');
    expect(theme.primaryColor).toBe('0 0% 8%');
    expect(JSON.stringify(theme)).not.toMatch(/222 29%|39 49%|40 62%/);
  });
  it('emits no look variables (no data-look scope for a legacy row)', () => {
    const vars = themeToCssVars(theme) as Record<string, string>;
    expect(Object.keys(vars).some(k => /^--look-/.test(k))).toBe(false);
  });
  it('getTemplateTheme(dahab) is the same neutral base', () => {
    expect(getTemplateTheme('dahab').backgroundColor).toBe('0 0% 100%');
  });
  it('a merchant who stored night colours keeps them as overrides (merchant > look > skin)', () => {
    const c = composeStoreTheme({
      template: 'dahab',
      look: null,
      theme: { backgroundColor: '222 29% 8%', primaryColor: '39 49% 58%' },
    });
    expect(c.backgroundColor).toBe('222 29% 8%');
    expect(c.primaryColor).toBe('39 49% 58%');
  });
});

describe('migrate-legacy-dahab.mjs', () => {
  it('keepDiff reports exactly the look-owned keys a store still has stored', () => {
    const kept = keepDiff(
      { backgroundColor: '222 29% 8%', primaryColor: '39 49% 58%', showQuickAdd: true },
      LOOK_OWNED_THEME_KEYS
    );
    expect(kept).toEqual(['backgroundColor', 'primaryColor']);
    expect(keepDiff(null, LOOK_OWNED_THEME_KEYS)).toEqual([]);
    expect(keepDiff({ showQuickAdd: true }, LOOK_OWNED_THEME_KEYS)).toEqual([]);
  });
  it('is a dry run unless --apply, defaults to Worn, and only accepts dahab looks', () => {
    const isDahab = (id: string) => id.startsWith('dahab.');
    expect(parseArgs([], isDahab)).toEqual({
      apply: false,
      look: DEFAULT_LOOK,
      yesProduction: false,
    });
    expect(DEFAULT_LOOK).toBe('dahab.worn');
    expect(parseArgs(['--apply', '--look', 'dahab.giftbox'], isDahab)).toMatchObject({
      apply: true,
      look: 'dahab.giftbox',
    });
    expect(parseArgs(['--look', 'qamar.atelier'], isDahab)).toHaveProperty('error');
    expect(parseArgs(['--look'], isDahab)).toHaveProperty('error');
  });
  it('refuses a non-loopback database without --yes-production, accepts loopback', () => {
    expect(guard('postgresql://u:p@ep-cool-1.neon.tech/db', []).ok).toBe(false);
    expect(guard('postgresql://u:p@ep-cool-1.neon.tech/db', ['--apply']).ok).toBe(false);
    expect(guard('postgresql://u:p@127.0.0.1:5432/db', []).ok).toBe(true);
    expect(guard('postgresql://u:p@localhost/db?host=ep-cool-1.neon.tech', []).ok).toBe(false);
    expect(guard('', []).ok).toBe(false);
  });
  it('main exits 2 (nothing connected, nothing written) against a non-loopback URL', async () => {
    const old = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://u:p@ep-cool-1.neon.tech/db';
    try {
      expect(await main(['--apply'])).toBe(2);
    } finally {
      if (old === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = old;
    }
  });
});
