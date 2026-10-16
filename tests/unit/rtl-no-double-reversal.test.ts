/**
 * R-01 (Qamar taste audit 2026-10-15, quality-bar § 2): direction comes from `dir`.
 *
 * Under `dir="rtl"` a flex row already starts at the right. `isRtl ? 'flex-row-reverse'`
 * reverses it a SECOND time, so the Arabic header put the wordmark on the left and the
 * footer links in English order (13 sites on the 4 default headers, the minimal footer
 * and the recommendations skeleton). The same family: a physical `left-*`/`right-*`/
 * `pl-*`/`pr-*`/`ml-*`/`mr-*` picked by a language ternary instead of a logical
 * `start-*`/`end-*`/`ps-*`/`pe-*`/`ms-*`/`me-*` utility; one of them (bold hero) put the
 * Arabic headline block flush LEFT.
 *
 * Gate: no file under apps/web/src picks a reversed or physical utility from a language /
 * direction ternary. Mirror through `dir` + logical utilities, never by hand.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '../..');
const WEB = join(ROOT, 'apps/web/src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : walk(p);
    return /\.(tsx|ts)$/.test(name) && !/\.test\.|\.spec\./.test(name) ? [p] : [];
  });
}

/** A language/direction condition followed by a ternary. */
const COND = String.raw`(?:isRtl|isRTL|rtl|isArabic|language\s*===\s*['"]ar['"]|dir(?:ection)?\s*===\s*['"]rtl['"])\s*\?`;
/** Either branch of the ternary: a quoted class string. */
const BRANCHES = String.raw`\s*(['"\`])([^'"\`]*)\1\s*:\s*(['"\`])([^'"\`]*)\3`;
const TERNARY = new RegExp(COND + BRANCHES, 'g');

const REVERSED = /(?:^|\s|:)(?:flex-row-reverse|space-x-reverse|order-(?:\d|first|last))\b/;
const PHYSICAL =
  /(?:^|\s|:)(?:-?(?:left|right|pl|pr|ml|mr)-(?:\d|\[|auto|px|full)|text-(?:left|right)\b)/;
/**
 * A LOGICAL utility that differs between the two branches is a reversal too: `ms-auto` already
 * means the right side in Arabic, so `isRtl ? 'ms-auto' : 'ms-0'` sends Arabic to the END.
 */
const LOGICAL_TOKEN =
  /^(?:[a-z0-9-]+:)*(?:-?(?:ms|me|ps|pe|start|end)-\S+|(?:text|items|justify|self|content)-(?:start|end))$/;
function flips(a: string, b: string): boolean {
  const pick = (s: string) =>
    s
      .split(/\s+/)
      .filter(t => LOGICAL_TOKEN.test(t))
      .sort()
      .join(' ');
  return pick(a) !== pick(b);
}

function offenders(src: string, rule: RegExp | 'logical-flip'): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(TERNARY)) {
    const hit = rule === 'logical-flip' ? flips(m[2], m[4]) : rule.test(m[2]) || rule.test(m[4]);
    if (hit) {
      const line = src.slice(0, m.index).split('\n').length;
      out.push(`${line}: ${m[0].replace(/\s+/g, ' ')}`);
    }
  }
  return out;
}

const files = walk(WEB);

describe('R-01: direction comes from dir, never from a language ternary', () => {
  it('scans the storefront', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it('no isRtl ? flex-row-reverse / order-N (double reversal under dir=rtl)', () => {
    const hits = files.flatMap(f =>
      offenders(readFileSync(f, 'utf8'), REVERSED).map(h => `${relative(ROOT, f)}:${h}`)
    );
    expect(hits).toEqual([]);
  });

  it('no physical left/right/pl/pr/ml/mr picked by a language ternary (use start/end/ps/pe/ms/me)', () => {
    const hits = files.flatMap(f =>
      offenders(readFileSync(f, 'utf8'), PHYSICAL).map(h => `${relative(ROOT, f)}:${h}`)
    );
    expect(hits).toEqual([]);
  });

  it('no logical utility (ms/me/ps/pe/start/end, *-start/*-end) that differs by language', () => {
    const hits = files.flatMap(f =>
      offenders(readFileSync(f, 'utf8'), 'logical-flip').map(h => `${relative(ROOT, f)}:${h}`)
    );
    expect(hits).toEqual([]);
  });

  it('the matcher catches the banned shapes (self-test)', () => {
    expect(offenders("x ${isRtl ? 'flex-row-reverse' : ''}", REVERSED)).toHaveLength(1);
    expect(
      offenders("${isRtl ? 'justify-end flex-row-reverse' : 'justify-start'}", REVERSED)
    ).toHaveLength(1);
    expect(
      offenders("${isRtl ? 'items-end sm:flex-row-reverse' : 'items-start'}", REVERSED)
    ).toHaveLength(1);
    expect(offenders("language === 'ar' ? 'flex-row-reverse' : 'flex-row'", REVERSED)).toHaveLength(
      1
    );
    expect(offenders("${isRtl ? 'lg:order-1' : 'lg:order-2'}", REVERSED)).toHaveLength(1);
    expect(offenders("${isRtl ? '-left-2' : '-right-2'}", PHYSICAL)).toHaveLength(1);
    expect(offenders("${isRtl ? 'pr-11 pl-4' : 'pl-11 pr-4'}", PHYSICAL)).toHaveLength(1);
    expect(
      offenders("${isRtl ? 'mr-auto ml-0 text-right' : 'ml-0 text-left'}", PHYSICAL)
    ).toHaveLength(1);
    expect(offenders("${isRtl ? 'text-right' : 'text-left'}", PHYSICAL)).toHaveLength(1);
    expect(offenders("(isRtl ? 'ms-auto' : 'ms-0')", 'logical-flip')).toHaveLength(1);
    expect(offenders("${isRtl ? 'items-end' : 'items-start'}", 'logical-flip')).toHaveLength(1);
    expect(offenders("${isRtl ? 'end-0 x' : 'end-0 y'}", 'logical-flip')).toHaveLength(0);
    // Allowed: a ternary on direction that only flips an icon or a transform.
    expect(offenders("${isRtl ? 'rotate-180' : ''}", PHYSICAL)).toHaveLength(0);
    expect(offenders("${isRtl ? '-translate-x-full' : 'translate-x-full'}", PHYSICAL)).toHaveLength(
      0
    );
  });
});
