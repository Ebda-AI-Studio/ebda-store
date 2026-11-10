import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * PR #511 review: the Menu's start button (`.nav-menu .menu-start`) became an `<a>`, and globals.css still had a
 * `display: list-item` rule for it at <=440px. It only lost to chrome.css's `display: flex` because chrome.css is
 * imported after globals.css (same specificity). A reordered import would have turned the button into a list row.
 *
 * The rule now: every `display` the marketing stylesheets give `.nav-menu .menu-start` sits in a media range that
 * overlaps no other one, so the result never depends on stylesheet order. This reads the three stylesheets
 * RootShell imports and checks the ranges, and that a phone (<=799px) gets `flex` and a wide screen `none`.
 */

const APP = join(__dirname, '../../apps/marketing/src/app');
const SHEETS = ['globals.css', 'chrome.css', 'services-chrome.css'];

type Rule = { sheet: string; min: number; max: number; display: string };

/** Top-level and one-level-@media rules that name `.menu-start` and set `display`. */
function menuStartRules(sheet: string): Rule[] {
  const css = readFileSync(join(APP, sheet), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Rule[] = [];
  const stack: { min: number; max: number }[] = [{ min: 0, max: Infinity }];
  let i = 0;
  let buf = '';
  while (i < css.length) {
    const c = css[i];
    if (c === '{') {
      const head = buf.trim();
      buf = '';
      if (head.startsWith('@media')) {
        const min = Number(head.match(/min-width:\s*(\d+)px/)?.[1] ?? 0);
        const max = Number(head.match(/max-width:\s*(\d+)px/)?.[1] ?? Infinity);
        stack.push({ min, max });
      } else if (head.startsWith('@')) {
        stack.push(stack[stack.length - 1]);
      } else {
        const end = css.indexOf('}', i);
        const body = css.slice(i + 1, end);
        const display = body.match(/(?:^|;)\s*display:\s*([^;]+)/)?.[1]?.trim();
        const names = head.split(',').map(s => s.trim());
        if (display && names.some(n => /(^|\s)\.menu-start$/.test(n))) {
          const range = stack[stack.length - 1];
          out.push({ sheet, min: range.min, max: range.max, display });
        }
        i = end + 1;
        continue;
      }
    } else if (c === '}') {
      stack.pop();
      buf = '';
    } else if (c === ';' && stack.length >= 1) {
      buf = ''; // an @import / declaration at top level, not a selector
    } else {
      buf += c;
    }
    i++;
  }
  return out;
}

const rules = SHEETS.flatMap(menuStartRules);
const at = (w: number) => rules.filter(r => w >= r.min && w <= r.max);

describe('marketing: the Menu start button display never depends on stylesheet order', () => {
  it('finds the rules it guards', () => {
    expect(rules.length).toBeGreaterThanOrEqual(2);
  });

  it('no two display rules for .menu-start overlap at any width', () => {
    for (let w = 280; w <= 1920; w++)
      expect(
        at(w).map(r => `${r.sheet} ${r.display}`),
        `${w}px`
      ).toHaveLength(1);
  });

  it('it is a flex button in the Menu up to 799px and hidden from 800px', () => {
    for (const w of [320, 360, 390, 440, 520, 680, 799])
      expect(at(w)[0].display, `${w}px`).toBe('flex');
    for (const w of [800, 1200, 1480]) expect(at(w)[0].display, `${w}px`).toBe('none');
  });

  it('the button is an <a>, so no rule may make it a list row', () => {
    expect(rules.filter(r => r.display === 'list-item')).toEqual([]);
  });
});
