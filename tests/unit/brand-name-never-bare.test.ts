import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Ruling BRAND-NAME-1 (Ahmad, 2026-10-23): never write "Ebda" (or the Arabic brand ابدأ/إبدأ) ALONE. Always the full
 * name: Ebda Store, Ebda Chat, Ebda CRM, Ebda ERP, or Ebda AI Studio (the company). The Arabic VERB ابدأ ("start",
 * as in «ابدأ متجرك») is NOT the brand and stays.
 *
 * Scans UI strings, emails, help/docs content, alt text, OG/JSON-LD sources and the storefront badge under apps/ and
 * packages/shared/src. Comments are not scanned. The Arabic check is a context heuristic (brand-as-noun positions:
 * after a preposition or noun, or followed by a subject-verb): the verb is never flagged.
 */
const ROOT = path.resolve(__dirname, '../..');
const SCAN = ['apps', 'packages/shared/src'];
const EXT = new Set(['.ts', '.tsx', '.mjs', '.json', '.mdx', '.html', '.txt']);
const SKIP_DIR = new Set([
  'node_modules',
  '.next',
  'out',
  'dist',
  '.open-next',
  '.wrangler',
  'coverage',
]);
const SKIP_FILE = [
  /\.test\./,
  /\.spec\./,
  /\.generated\./,
  /\.snap$/,
  /package(-lock)?\.json$/,
  /tsconfig/,
];

/** Technical identifiers that carry the word on the wire (headers, user-agents, log tags). Not display text. */
const EN_ALLOW: RegExp[] = [
  /X-Ebda-/,
  /Ebda-Webhooks/,
  /tag: 'Ebda(?:-(?:API|Admin|Web))?'/,
  /Ebda own ads/,
  // the registered legal entity (LEGAL-NAME-2): legalNameEn 'Ebda Studio' (the marketing name stays Ebda AI Studio)
  /legalNameEn:\s*'Ebda Studio'/,
];

// SERVICES-IA-1: the coming-soon software (Quote Studio, Events Platform, Marketing Platform) and the three services (Events, Marketing, Design) are full names too
const EN_BARE =
  /\bEbda\b(?! (?:Store|Chat|AI Studio|CRM|ERP|Quote Studio|Invite|Ads|Events|Marketing|Design)\b)/g;
const AR_BRAND = '(?:ابدأ|إبدأ|إبدا)';
const AR_LETTER = '[\\u0621-\\u064A\\u0671-\\u06D3]';
const AR_NEXT_OK = `(?!\\s*(?:ستور|ستوديو|استوديو|شات|واتساب|WhatsApp|CRM|ERP|Store|إيفنتس|ماركتنج|ديزاين|إنفايت|آدز)(?!${AR_LETTER}))`;
const AR_END = `(?!${AR_LETTER})`;
const AR_CTX = [
  // brand as the object of a preposition or a noun: «من ابدأ», «على إبدأ», «مدعوم من ابدأ», «تواصل مع ابدأ»
  new RegExp(
    `(?:^|[\\s«"'(])(?:من|على|مع|عن|لـ|بـ|في|إلى|عند|خارج|وصول|اسم|منصة|واتساب|تسجيل|اشتراك|فواتير|أعمال|بتوصل لـ?)\\s+${AR_BRAND}${AR_END}${AR_NEXT_OK}`
  ),
  // brand as the subject of a verb: «ابدأ بيعمل», «إبدأ بتدعم», «لا تأخذ ابدأ أي»
  new RegExp(
    `${AR_BRAND}\\s+(?:بيعمل|بيبعت|بيدي|بيدعم|بيحجز|بيضيف|بيسأل|بيطلب|بيفحص|بيحاول|بيعرض|بيتأكد|بتدعم|بتتعرف|بتبعت|بتحدد|بتقدّم|ما\\s+بتقدّمش|لسه|هي\\b|نفسها|مش\\b|راح|أي\\s)`
  ),
  new RegExp(`(?:تأخذ|تلزقها|يلزم)\\s+${AR_BRAND}${AR_END}${AR_NEXT_OK}`),
  // fused to a one-letter preposition: لابدأ, بابدأ, كابدأ (never و/ف: وابدأ متجرك is the verb)
  new RegExp(`(?:^|[\\s«"'(])[لبك]ـ?${AR_BRAND}${AR_END}${AR_NEXT_OK}`),
  new RegExp(`"forceBrandPrefix": "${AR_BRAND}"`),
];
/** Arabic lines allowed to match (verbs the heuristic cannot tell apart). */
const AR_ALLOW: RegExp[] = [/ابدأ\s+(?:بـ|بإنشاء|بمنتج|بالدفع|بالقراءة|من\s)/];

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* files(p);
    else if (EXT.has(path.extname(name)) && !SKIP_FILE.some(r => r.test(name))) yield p;
  }
}

const isComment = (line: string) => /^\s*(?:\/\/|\*|\/\*|\{\/\*|#)/.test(line);
const stripTrailingComment = (line: string) => line.replace(/\s\/\/\s.*$/, '');

/** Blank out the allowed spans only, so an allowlisted token never hides a bare brand elsewhere on the line. */
const mask = (line: string, allow: RegExp[]) =>
  allow.reduce((l, a) => l.replace(new RegExp(a.source, 'g'), m => ' '.repeat(m.length)), line);

/** What is wrong with one line of UI text (empty = fine). The only place the rules are applied. */
function scanLine(line: string): string[] {
  const kinds: string[] = [];
  if (EN_BARE_RE().test(mask(line, EN_ALLOW))) kinds.push('bare "Ebda"');
  if (AR_CTX.some(r => r.test(mask(line, AR_ALLOW)))) kinds.push('bare Arabic brand');
  return kinds;
}
const EN_BARE_RE = () => new RegExp(EN_BARE.source);

function bare(file: string): string[] {
  const out: string[] = [];
  const rel = path.relative(ROOT, file);
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((raw, i) => {
    const jsLike = /\.(?:ts|tsx|mjs)$/.test(file);
    if (jsLike && isComment(raw)) return;
    const line = jsLike ? stripTrailingComment(raw) : raw;
    if (/from '|import\(/.test(line)) return;
    for (const kind of scanLine(line))
      out.push(`${rel}:${i + 1}: ${kind}: ${line.trim().slice(0, 110)}`);
  });
  return out;
}

describe('BRAND-NAME-1: the brand is never written alone', () => {
  it('no UI string, email, help/docs page or metadata names the brand bare', () => {
    const hits = SCAN.flatMap(d => [...files(path.join(ROOT, d))]).flatMap(bare);
    expect(hits, hits.join('\n')).toEqual([]);
  });

  it('negative control: the scanner flags a bare brand and passes the full names and the verb', () => {
    const probe = (s: string) => scanLine(s).length > 0;
    expect(probe('Powered by Ebda')).toBe(true);
    expect(probe('Powered by Ebda Store')).toBe(false);
    expect(probe('Contact Ebda AI Studio')).toBe(false);
    expect(probe('مدعوم من ابدأ')).toBe(true);
    expect(probe('مدعوم من ابدأ ستور')).toBe(false);
    expect(probe('ابدأ بيعمل طلب')).toBe(true);
    expect(probe('ابدأ متجرك أونلاين')).toBe(false);
    expect(probe('ابدأ دلوقتي')).toBe(false);
    expect(probe('تواصل مع ابدأ ستوديو للذكاء الاصطناعي')).toBe(false);
    // an allowlisted token must not hide a bare brand elsewhere on the same line
    expect(probe('X-Ebda-Id header, Powered by Ebda')).toBe(true);
    expect(probe('X-Ebda-Signature: t=1')).toBe(false);
    expect(probe('ابدأ بـ كذا و مدعوم من ابدأ')).toBe(true);
    // brand fused to a one-letter preposition
    expect(probe('حساب بابدأ')).toBe(true);
    expect(probe('من لابدأ')).toBe(true);
    expect(probe('وابدأ متجرك')).toBe(false); // the verb with و
  });
});
