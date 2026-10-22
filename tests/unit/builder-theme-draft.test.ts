/**
 * Draft theme patch (`PageDefinition.theme`, Ruling THEME-DRAFT-1): the schema
 * accepts only the keys / value types the editor's THEME_SETTINGS_SCHEMA
 * declares, and the pure helpers merge / snapshot correctly.
 */
import { describe, it, expect } from 'vitest';
import {
  DERIVED_THEME_KEYS,
  DRAFT_THEME_KEYS,
  THEME_SETTINGS_SCHEMA,
  effectiveTheme,
  layoutToDefinition,
  resolveLayoutSettings,
  snapshotEditableTheme,
  validateDefinitionSync,
  type PageDefinition,
} from '@ebda/shared';

const base = (): PageDefinition => layoutToDefinition(resolveLayoutSettings({}, 'modern'));
const withTheme = (theme: unknown) => ({ ...base(), theme }) as unknown;

describe('draft theme schema', () => {
  it('a document without a theme patch is unchanged (backward compatible)', () => {
    expect(validateDefinitionSync(base()).ok).toBe(true);
  });

  it('accepts editor-managed keys with the declared value types', () => {
    const r = validateDefinitionSync(
      withTheme({ primaryColor: '200 50% 40%', uppercaseStyle: true, borderRadius: 'lg' })
    );
    expect(r.ok).toBe(true);
  });

  it('rejects keys the editor does not manage (cannot be a side door into stores.theme)', () => {
    const r = validateDefinitionSync(withTheme({ showBranchesInFooter: true }));
    expect(r.ok).toBe(false);
    expect(r.errors[0].path).toBe('/theme/showBranchesInFooter');
  });

  it('rejects the wrong value type and oversized strings', () => {
    expect(validateDefinitionSync(withTheme({ uppercaseStyle: 'yes' })).ok).toBe(false);
    expect(validateDefinitionSync(withTheme({ primaryColor: true })).ok).toBe(false);
    expect(validateDefinitionSync(withTheme({ headingFont: 'x'.repeat(101) })).ok).toBe(false);
  });

  it('every editable key is a THEME_SETTINGS_SCHEMA setting or a colour token Smart Palette derives', () => {
    const all = THEME_SETTINGS_SCHEMA.flatMap(g => g.settings.map(s => String(s.id)));
    expect(DRAFT_THEME_KEYS).toContain('primaryColor');
    expect(DRAFT_THEME_KEYS).not.toContain('dividers');
    for (const k of DRAFT_THEME_KEYS)
      expect([...all, ...(DERIVED_THEME_KEYS as readonly string[])]).toContain(k);
    // the derived tokens have no control of their own
    for (const k of DERIVED_THEME_KEYS) expect(all).not.toContain(k);
  });
});

describe('theme helpers', () => {
  it('effectiveTheme paints the draft patch over the live theme without mutating either', () => {
    const live = { primaryColor: 'a', fontFamily: 'serif' };
    const out = effectiveTheme(live, { primaryColor: 'b' });
    expect(out).toEqual({ primaryColor: 'b', fontFamily: 'serif' });
    expect(live.primaryColor).toBe('a');
    expect(effectiveTheme(live, undefined)).toEqual(live);
  });

  it('snapshotEditableTheme keeps only editor-managed keys, patch winning over live', () => {
    const snap = snapshotEditableTheme(
      { primaryColor: 'a', fontFamily: 'serif', showBranchesInFooter: true, categoryCountUnit: {} },
      { primaryColor: 'b' }
    );
    expect(snap).toEqual({ primaryColor: 'b', fontFamily: 'serif' });
  });
});
