/**
 * No-look regression from the taste re-audit (2026-10-16): on a store with no look the size and
 * length chips drew #E5E7EB on white, 1.24:1. VT-05 routes every interactive boundary through
 * `--input`, but on a store with no look `--input` itself was the decorative border, so the class
 * gate passed while the pixels failed. The composed theme now holds `--input` to >= 3:1 against
 * the page on every skin, every look and a merchant's saved light border (WCAG 1.4.11).
 */
import { describe, it, expect } from 'vitest';
import { composeStoreTheme } from './compose';
import { LOOKS } from './registry';
import { contrastRatio } from '../utils/color';
import type { TemplateId } from '../types/store-theme';

const SKINS: TemplateId[] = ['modern', 'classic', 'minimal', 'bold', 'elegant', 'dahab', 'qamar'];
const ratio = (t: { inputColor: string; backgroundColor: string }) =>
  contrastRatio(t.backgroundColor, t.inputColor);

describe('the composed --input is a visible boundary (>= 3:1)', () => {
  it.each(SKINS)('skin %s, no look', template => {
    expect(ratio(composeStoreTheme({ template, look: null, theme: null }))).toBeGreaterThanOrEqual(
      3
    );
  });
  it.each(LOOKS.map(l => l.id))('look %s', look => {
    expect(
      ratio(composeStoreTheme({ template: 'qamar', look, theme: null }))
    ).toBeGreaterThanOrEqual(3);
  });
  it('a merchant saved light border with no input colour', () => {
    const t = composeStoreTheme({
      template: 'minimal',
      look: null,
      theme: { borderColor: '220 13% 91%' },
    });
    expect(ratio(t)).toBeGreaterThanOrEqual(3);
  });
  it('keeps the hue of the colour it strengthens and never touches the decorative border', () => {
    const t = composeStoreTheme({ template: 'minimal', look: null, theme: null });
    expect(t.inputColor.split(' ')[0]).toBe(t.borderColor.split(' ')[0]);
    expect(t.borderColor).toBe('220 13% 91%');
  });
});
