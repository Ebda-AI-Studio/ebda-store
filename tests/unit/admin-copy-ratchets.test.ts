/**
 * Copy ratchets for the admin fix pass (UX:C-4, C-2, M-4). Each rule has a recorded baseline in
 * admin-copy-ratchets-baseline.json; a count may only go DOWN. A track that fixes its pages lowers its own
 * numbers (one line each); a new violation, or a file over its recorded count, fails.
 *
 *  C-4  Egyptian register: Modern Standard / stiff openers in admin Arabic sentences, counted per top-level
 *       namespace of ar.json (fragments overlaid, because a track's override is the fix).
 *  C-2  English literals passed as the FIRST argument of the error setters, toast helpers, showError, alert
 *       and confirm: counted per file. The 'i18n literal' guards cannot see these shapes.
 *  M-4  Text below the 12px floor (`text-[10px]`, `text-[11px]`): counted per file. 11px stays legal on chart
 *       axis ticks (files under a `charts` folder are exempt).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '../../apps/admin/src');
const BASELINE = JSON.parse(
  readFileSync(join(__dirname, 'admin-copy-ratchets-baseline.json'), 'utf8')
) as {
  register: Record<string, number>;
  englishFeedback: Record<string, number>;
  smallText: Record<string, number>;
};

// ---------- C-4 ----------
type Messages = { [key: string]: string | Messages };
function loadArabic(): Messages {
  const base = JSON.parse(readFileSync(join(SRC, 'i18n/messages/ar.json'), 'utf8')) as Messages;
  const dir = join(SRC, 'i18n/fragments');
  if (!existsSync(dir)) return base;
  const overlay = (dst: Messages, src: Messages) => {
    for (const [k, v] of Object.entries(src)) {
      if (v && typeof v === 'object') {
        const cur = dst[k];
        dst[k] = overlay(cur && typeof cur === 'object' ? (cur as Messages) : {}, v as Messages);
      } else dst[k] = v;
    }
    return dst;
  };
  for (const f of readdirSync(dir).filter(n => n.endsWith('.ar.json'))) {
    overlay(base, JSON.parse(readFileSync(join(dir, f), 'utf8')) as Messages);
  }
  return base;
}
function flatten(obj: Messages, prefix = '', out: Record<string, string> = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flatten(v as Messages, key, out);
    else out[key] = v as string;
  }
  return out;
}
const LEGAL_KEY = /legal|terms|privacy|policy|policies|consent|dpa|notice/i;
// Stiff openers a shopkeeper does not say. Short button labels never match (they have no sentence shape).
const STIFF = /(^|[\s«"(])(تم |من فضلك|سيتم |سوف |قم بـ|قم ب|هل أنت متأكد|لقد )/;

describe('C-4 Egyptian register ratchet', () => {
  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(flatten(loadArabic()))) {
    if (LEGAL_KEY.test(k) || !STIFF.test(v)) continue;
    const ns = k.split('.')[0];
    counts[ns] = (counts[ns] ?? 0) + 1;
  }
  it('no namespace exceeds its recorded count of stiff sentences', () => {
    const over = Object.entries(counts)
      .filter(([ns, n]) => n > (BASELINE.register[ns] ?? 0))
      .map(([ns, n]) => `${ns}: ${n} > ${BASELINE.register[ns] ?? 0}`);
    expect(over).toEqual([]);
  });
});

// ---------- C-2 and M-4 ----------
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'node_modules' ? [] : walk(p);
    return /\.tsx?$/.test(n) && !/\.(test|spec)\./.test(n) && !p.includes('__tests__') ? [p] : [];
  });
}
const files = walk(SRC).map(p => ({ rel: relative(SRC, p), src: readFileSync(p, 'utf8') }));

const ENGLISH_FEEDBACK =
  /(set(?:Error|Message|Msg|Notice)|toast[A-Za-z.]*|showError|alert|confirm)\(\s*['"`][A-Za-z]{3}/g;
const SMALL_TEXT = /text-\[(?:9|10|11)px\]/g;

describe('C-2 English feedback literals ratchet', () => {
  it('no file exceeds its recorded count', () => {
    const over = files
      .map(f => [f.rel, (f.src.match(ENGLISH_FEEDBACK) ?? []).length] as const)
      .filter(([rel, n]) => n > (BASELINE.englishFeedback[rel] ?? 0))
      .map(([rel, n]) => `${rel}: ${n} > ${BASELINE.englishFeedback[rel] ?? 0}`);
    expect(over).toEqual([]);
  });
});

describe('M-4 12px text floor ratchet', () => {
  it('no file exceeds its recorded count (axis ticks under charts/ are exempt)', () => {
    const over = files
      .filter(f => !/(^|\/)charts?\//.test(f.rel))
      .map(f => [f.rel, (f.src.match(SMALL_TEXT) ?? []).length] as const)
      .filter(([rel, n]) => n > (BASELINE.smallText[rel] ?? 0))
      .map(([rel, n]) => `${rel}: ${n} > ${BASELINE.smallText[rel] ?? 0}`);
    expect(over).toEqual([]);
  });
});

// ---------- R-1 ----------
describe('R-1 no direction glyphs inside messages', () => {
  it('ar.json and en.json carry no ← or → (use ArrowStart / ArrowEnd, or a "›" path separator)', () => {
    const offenders: string[] = [];
    for (const lang of ['ar', 'en']) {
      const msgs = JSON.parse(
        readFileSync(join(SRC, `i18n/messages/${lang}.json`), 'utf8')
      ) as Messages;
      for (const [k, v] of Object.entries(flatten(msgs)))
        if (/[←→]/.test(v)) offenders.push(`${lang}:${k}`);
    }
    expect(offenders).toEqual([]);
  });
});

// ---------- C-7 ----------
describe('C-7 no amber utility classes', () => {
  it('warnings use the --warning brass tokens (bg-warning/10, text-warning-ink, border-warning/40)', () => {
    const AMBER = /\b(?:bg|text|border|ring|from|to|via|fill|stroke|divide)-amber-\d/;
    const offenders = files.filter(f => AMBER.test(f.src)).map(f => f.rel);
    expect(offenders).toEqual([]);
  });
});
