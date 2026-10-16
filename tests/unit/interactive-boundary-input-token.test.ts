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

/** Formerly the W2b-owned card files (Ruling B1-55); emptied by W2b. */
const W2B_CARD_FILES = new Set<string>([
  // Emptied in W2b (N-1, Ruling B1-61): the card files and the 4 mappers are scanned like every
  // other storefront file. Keep it empty; an entry here is an unruled exception.
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
  for (let j = at - 1; j >= 0; j--) {
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
  return files(WEB).flatMap(f => {
    const rel = path.relative(WEB, f);
    return W2B_CARD_FILES.has(rel) ? [] : scanSource(rel, readFileSync(f, 'utf8'));
  });
}

/** The scanner on one file's source (exported so the fixture self-test below drives it). */
export function scanSource(rel: string, src: string): string[] {
  const out: string[] = [];
  {
    const seen = new Set<number>();
    for (const m of src.matchAll(/\bborder-border\b/g)) {
      const tag = enclosingTag(src, m.index!);
      if (!tag || seen.has(tag.start)) continue;
      const open = src.slice(tag.start, tagEnd(src, tag.start) + 1);
      // a full border (`border` / `border-2`) anywhere in the opening tag's classes; the colour may
      // sit in a conditional branch (`selected ? 'border-primary' : 'border-border'`)
      const fullBorder = /[\s'"`]border(-2)?(?=[\s'"`])/.test(open);
      if (!fullBorder) continue;
      // A whole-card link's own surface frame is the card's decoration, not a control boundary:
      // it carries a source-only `/* boundary: card-frame */` marker (W2b, Ruling B1-61), visible and
      // greppable, with no markup change for stores that render it.
      if (/\/\* boundary: card-frame\b/.test(open)) continue;
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
  // N-2 (W2a re-review): a fixture self-test, not one string match in one file, so a scanner that
  // stops seeing control shapes goes red here instead of passing on an empty result.
  it.each([
    ['a bordered button', '<button className="rounded border border-border px-2">x</button>', 1],
    [
      'a Link with the hairline in a branch',
      "<Link className={`border ${on ? 'border-primary' : 'border-border'}`} href=\"/\">x</Link>",
      1,
    ],
    [
      'a clickable choice label',
      '<label className="cursor-pointer border border-border">x</label>',
      1,
    ],
    ['a role=radio div', '<div role="radio" className="border-2 border-border">x</div>', 1],
    [
      'a stepper group',
      '<div className="flex border border-border"><button aria-label="Decrease">-</button><span>1</span><button>+</button></div>',
      1,
    ],
    [
      'a whole-card frame marked as decoration',
      '<Link /* boundary: card-frame */ className="border border-border" href="/">x</Link>',
      0,
    ],
    ['a one-sided separator', '<button className="border-b border-border">x</button>', 0],
    ['a control on the input token', '<button className="border border-input">x</button>', 0],
    ['a bordered non-control', '<div className="border border-border"><p>x</p></div>', 0],
  ])('fixture: %s', (_name, src, hits) => {
    expect(scanSource('fixture.tsx', src as string)).toHaveLength(hits as number);
  });
  it('no interactive element or control group draws a full border-border boundary', () => {
    expect(boundaryViolations()).toEqual([]);
  });
});
