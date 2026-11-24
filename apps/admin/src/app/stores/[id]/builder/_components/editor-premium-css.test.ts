/**
 * Findings 65 + 67: the editor-scoped focus / selection / scrollbar / numerals rules and the ONE
 * enter recipe live in globals.css, are scoped (never global), and are off under reduced motion;
 * the editor surfaces carry the recipe classes. jsdom has no layout, so this reads the source.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, '../../../../../styles/globals.css'), 'utf8');
const src = (f: string) => readFileSync(join(__dirname, f), 'utf8');
const editorCss = css.slice(css.indexOf('Visual editor premium pass'));

describe('65: editor chrome tokens are scoped to .editor-shell', () => {
  it('one gold ring from --ring, selection tint, thin scrollbars, tabular numerals', () => {
    expect(editorCss).toMatch(/\.editor-shell :focus-visible \{[^}]*hsl\(var\(--ring\)\)/);
    expect(editorCss).toMatch(/\.editor-shell ::selection \{[^}]*var\(--primary\)/);
    expect(editorCss).toMatch(/scrollbar-width: thin/);
    expect(editorCss).toMatch(/input\[type='number'\][^{]*\{[^}]*tabular-nums/);
  });
  it('every rule in the block is scoped to the editor shell or an editor-motion class', () => {
    const selectors = [...editorCss.matchAll(/^([.\[@][^{\n]*)\{/gm)].map(m => m[1].trim());
    const unscoped = selectors.filter(
      s => !/^(\.editor-|@keyframes|@media|\[dir=)/.test(s) && !s.startsWith('.editor-shell')
    );
    expect(unscoped).toEqual([]);
  });
  it('the editor root carries the scope class', () => {
    expect(src('BuilderEditor.tsx')).toContain('editor-shell');
  });
});

describe('67: one enter recipe, 150-250ms, off under reduced motion', () => {
  it('uses the motion tokens (150 / 200ms, the shared ease) and nothing longer', () => {
    expect(css).toMatch(/--dur-fast: 150ms/);
    expect(css).toMatch(/--dur-base: 200ms/);
    expect(css).toContain('--ease-out: cubic-bezier(0.2, 0, 0, 1)');
    const used = [...editorCss.matchAll(/animation: [\w-]+ var\(--dur-(\w+)\)/g)].map(m => m[1]);
    expect(used.length).toBeGreaterThanOrEqual(4);
    expect(used.every(d => d === 'fast' || d === 'base')).toBe(true);
  });
  it('every recipe class is disabled under prefers-reduced-motion', () => {
    const reduced = editorCss.slice(editorCss.indexOf('prefers-reduced-motion'));
    for (const c of [
      '.editor-motion-pop',
      '.editor-motion-dialog[open]',
      '.editor-motion-drawer-start',
      '.editor-motion-drawer-end',
    ])
      expect(reduced).toContain(c);
    expect(reduced).toMatch(/animation: none/);
  });
  it('popovers, menus, dialogs and drawers carry the recipe', () => {
    expect(src('HeaderPopover.tsx')).toContain('editor-motion-pop');
    expect(src('RowMenu.tsx')).toContain('editor-motion-pop');
    expect(src('ConfirmDialog.tsx')).toContain('editor-motion-dialog');
    expect(src('AddSectionDialog.tsx')).toContain('editor-motion-dialog');
    expect(src('ShortcutSheet.tsx')).toContain('editor-motion-dialog');
    const ed = src('BuilderEditor.tsx');
    expect(ed).toContain('editor-motion-drawer-start');
    expect(ed).toContain('editor-motion-drawer-end');
  });
});
