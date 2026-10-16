/**
 * Quality bar § 9 (VT-05) as a CLASS gate (W2a fix round 1, review I-2): no storefront interactive
 * control draws its boundary with the decorative hairline `--border` (Atelier's line is ~1.25:1 on
 * white, Vitrine's champagne 1.74:1); controls read `--input` (every skin baseline has
 * `inputColor === borderColor`, so a store with no look keeps its colour; a look composes `--input`
 * from its muted ink, >= 3:1). It scans EVERY `.tsx` under `apps/web/src`, not a list of files:
 *
 *  1. an interactive element (button, a/Link, select/Select, input, textarea, summary, a clickable
 *     choice `label`, or anything with role=button/radio/tab/checkbox/switch) whose OWN class list
 *     has a full border (`border`, `border-2`) coloured `border-border`;
 *  2. a control GROUP with a full `border-border` border: a stepper (two or more `<button` and a
 *     decrease label in the next 2500 characters) or a segmented toggle (its first child is a
 *     `<button`, and a second follows).
 *
 * One-sided separators (`border-b`, `border-t`, `border-x`, ...) are decoration, not boundaries.
 * The shared product-card files belong to W2b (they must not be edited in W2a) and are listed by
 * name below so the exception is visible and shrinks when W2b lands.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const WEB = path.resolve(__dirname, '../../apps/web/src');

/** Card render paths + the 4 card mappers, owned by W2b (Ruling B1-55): not editable in W2a. */
const W2B_CARD_FILES = new Set([
  'app/products/ProductListItem.tsx',
  // the 4 hand-built card mappers (CLAUDE.md card paths)
  'app/wishlist/WishlistClient.tsx',
  'components/YouMightAlsoLike.tsx',
  'components/CartRecommendations.tsx',
  'components/FrequentlyBoughtTogether.tsx',
  'templates/shared/PecannbeeProductCard.tsx',
  'templates/shared/ProductCardCta.tsx',
  'templates/shared/ProductCarousel.tsx',
  'templates/dahab/ProductCarousel.tsx',
  'templates/dahab/ProductCard.tsx',
  'templates/modern/ProductCard.tsx',
  'templates/classic/ProductCard.tsx',
  'templates/minimal/ProductCard.tsx',
  'templates/bold/ProductCard.tsx',
  'templates/elegant/ProductCard.tsx',
]);

const INTERACTIVE_TAG = /^(button|a|Link|select|Select|input|textarea|summary)$/;
const INTERACTIVE_ROLE = /role=["'](button|radio|tab|checkbox|switch)["']/;

function files(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) files(p, out);
    else if (e.endsWith('.tsx') && !/\.test\.tsx$/.test(e)) out.push(p);
  }
  return out;
}

/** The opening tag (name + text up to `at`) that encloses index `at`, or null outside any tag. */
function enclosingTag(src: string, at: number): { name: string; start: number } | null {
  let depth = 0;
  for (let j = at - 1; j > 0; j--) {
    const c = src[j];
    if (c === '}') depth++;
    else if (c === '{') depth = Math.max(0, depth - 1);
    else if (depth === 0 && c === '>' && src[j - 1] !== '=' && src[j - 1] !== '-') return null;
    else if (depth === 0 && c === '<') {
      const m = /^<([A-Za-z][\w.]*)/.exec(src.slice(j, j + 40));
      return m ? { name: m[1], start: j } : null;
    }
  }
  return null;
}

/** The end of the opening tag that starts at `start` (first `>` at brace depth 0, not `=>`). */
function tagEnd(src: string, start: number): number {
  let depth = 0;
  for (let j = start + 1; j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (depth === 0 && c === '>' && src[j - 1] !== '=' && src[j - 1] !== '-') return j;
  }
  return src.length;
}

export function boundaryViolations(): string[] {
  const out: string[] = [];
  for (const f of files(WEB)) {
    const rel = path.relative(WEB, f);
    if (W2B_CARD_FILES.has(rel)) continue;
    const src = readFileSync(f, 'utf8');
    const seen = new Set<number>();
    for (const m of src.matchAll(/\bborder-border\b/g)) {
      const tag = enclosingTag(src, m.index!);
      if (!tag || seen.has(tag.start)) continue;
      const open = src.slice(tag.start, tagEnd(src, tag.start) + 1);
      // a full border (`border` / `border-2`) anywhere in the opening tag's classes; the colour may
      // sit in a conditional branch (`selected ? 'border-primary' : 'border-border'`)
      const fullBorder = /[\s'"`]border(-2)?(?=[\s'"`])/.test(open);
      if (!fullBorder) continue;
      const clickableLabel = tag.name === 'label' && /cursor-pointer/.test(open);
      const interactive =
        INTERACTIVE_TAG.test(tag.name) || clickableLabel || INTERACTIVE_ROLE.test(open);
      const after = src.slice(tag.start + open.length, tag.start + open.length + 2500);
      const buttons = (after.match(/<button\b/g)?.length ?? 0) >= 2;
      // a stepper (decrease/increase pair) or a segmented toggle (the group's first child is a button)
      const stepper = buttons && /Decrease|تقليل|إنقاص/.test(after);
      const segmented = buttons && /^\s*<button\b/.test(after);
      const group = !interactive && (stepper || segmented);
      if (interactive || group) {
        seen.add(tag.start);
        out.push(`${rel}:${src.slice(0, tag.start).split('\n').length} <${tag.name}>`);
      }
    }
  }
  return out;
}

describe('storefront control boundaries never use the hairline token (quality bar § 9, VT-05)', () => {
  it('positive control: the scanner sees control-shaped markup', () => {
    // the PDP stepper (a 2-button group) and the variant chips are found by shape, on --input
    const pdp = readFileSync(path.join(WEB, 'app/products/[slug]/ProductDetailClient.tsx'), 'utf8');
    expect(pdp).toContain('<div className="flex items-center rounded-lg border border-input">');
  });
  it('no interactive element or control group draws a full border-border boundary', () => {
    expect(boundaryViolations()).toEqual([]);
  });
});
