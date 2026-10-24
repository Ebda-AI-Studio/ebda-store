import { describe, it, expect } from 'vitest';
// @ts-expect-error plain .mjs helper without types
import * as lib from '../../apps/marketing/scripts/looks/snapshot-lib.mjs';
// @ts-expect-error plain .mjs
import { STORES } from '../../apps/marketing/scripts/looks/snapshot.mjs';
import { DEMO_STORES } from '../../apps/marketing/src/lib/site';

describe('looks snapshot helpers (MKT-PHONES-1)', () => {
  it('splits selector lists only at top-level commas', () => {
    expect(lib.splitSelectors('.a, .b:is(.c, .d), [x="1,2"]')).toEqual([
      '.a',
      '.b:is(.c, .d)',
      '[x="1,2"]',
    ]);
  });

  it('html/body/:root become the .x-root wrapper, everything else a descendant', () => {
    expect(lib.scopeSelector(':root')).toBe('@@ .x-root');
    expect(lib.scopeSelector('html[dir="rtl"] .a')).toBe('@@ .x-root[dir="rtl"] .a');
    expect(lib.scopeSelector('body:has(.x)')).toBe('@@ .x-root:has(.x)');
    expect(lib.scopeSelector('.btn')).toBe('@@ .btn');
    expect(lib.scopeSelector('*')).toBe('@@ *');
    expect(lib.scopeSelector('::backdrop')).toBeNull();
    expect(lib.scopeSelectorList('.a,.b')).toBe('@@ .a,@@ .b');
  });

  it('viewport units become phone (container) units', () => {
    expect(lib.phoneUnits('height:100vh;min-height:calc(100dvh - 4rem);width:50vw')).toBe(
      'height:100cqh;min-height:calc(100cqh - 4rem);width:50cqw'
    );
  });

  it('renames only selector classes, and class attributes consistently', () => {
    const names = new Set(['btn']);
    expect(lib.renameClassesCss('.btn{color:red}.btn-x{color:blue}', names)).toBe(
      '.x-btn{color:red}.btn-x{color:blue}'
    );
    expect(lib.renameClassesHtml('<a class="btn btn-x">', names)).toBe('<a class="x-btn btn-x">');
  });

  it('writes a rule once when every phone has it, per phone otherwise', () => {
    const css = lib.mergeRules([
      { id: 'a', rules: ['@@ .p{x:1}', '@@ .q{y:1}'] },
      { id: 'b', rules: ['@@ .p{x:1}'] },
    ]);
    expect(css).toBe(':is(#a,#b) .p{x:1}#a .q{y:1}');
  });

  it("keeps each phone's own rule order when it hoists shared rules", () => {
    const css = lib.mergeRules([
      { id: 'a', rules: ['@@ .x{c:1}', '@@ .s{k:1}', '@@ .y{c:2}'] },
      { id: 'b', rules: ['@@ .s{k:1}', '@@ .z{c:3}'] },
    ]);
    expect(css).toBe('#a .x{c:1}:is(#a,#b) .s{k:1}#a .y{c:2}#b .z{c:3}');
    // a shared rule that sits in a different order in another phone is not hoisted
    const swapped = lib.mergeRules([
      { id: 'a', rules: ['@@ .p{a:1}', '@@ .q{a:2}'] },
      { id: 'b', rules: ['@@ .q{a:2}', '@@ .p{a:1}'] },
    ]);
    expect(swapped).toContain(':is(#a,#b) .p{a:1}');
    expect(swapped).toContain('#b .q{a:2}'); // q stayed per phone: b keeps q before p
  });

  it('prefixes keyframes names in the rule and in animation declarations only', () => {
    const names = lib.keyframeNames(['@keyframes spin{to{transform:rotate(1turn)}}']);
    expect([...names]).toEqual(['spin']);
    expect(lib.prefixKeyframes('@keyframes spin{to{x:1}}', names, 'ph-q-')).toBe(
      '@keyframes ph-q-spin{to{x:1}}'
    );
    expect(
      lib.prefixKeyframes('@@ .a{animation: spin 1s linear infinite;color:red}', names, 'ph-q-')
    ).toBe('@@ .a{animation: ph-q-spin 1s linear infinite;color:red}');
    // a class called spin is not an animation
    expect(lib.prefixKeyframes('@@ .spin{color:red}', names, 'ph-q-')).toBe('@@ .spin{color:red}');
  });

  it('reads Google Fonts families from a stylesheet URL', () => {
    expect(
      lib.googleFamilies(
        'https://fonts.googleapis.com/css2?family=Noto+Naskh+Arabic:wght@400;700&family=Lalezar&display=swap'
      )
    ).toEqual(['Noto+Naskh+Arabic:wght@400;700', 'Lalezar']);
    expect(lib.googleFamilies('https://evil.example/css2?family=X')).toEqual([]);
  });

  it('drift diff names the template and look, and ignores engine classes', () => {
    const a = lib.normalise('<style>.a{}</style><!--look--><div class="x ps-on">مرحبا</div>');
    const same = lib.normalise('<style>.b{}</style><!--look--><div class="x">مرحبا</div>');
    const text = lib.normalise('<!--look--><div class="x">أهلا</div>');
    expect(lib.diffNormalised('souq', a, same)).toEqual([]);
    expect(lib.diffNormalised('souq', a, text)).toEqual(['souq look A: visible text differs']);
  });

  it('snapshot STORES stay in step with the site DEMO_STORES (hosts and look ids, A/B/C order)', () => {
    for (const t of Object.keys(DEMO_STORES) as (keyof typeof DEMO_STORES)[]) {
      expect(STORES[t].host).toBe(DEMO_STORES[t].host);
      expect(STORES[t].looks.map((l: string[]) => l[0])).toEqual([...DEMO_STORES[t].looks]);
    }
  });
});
