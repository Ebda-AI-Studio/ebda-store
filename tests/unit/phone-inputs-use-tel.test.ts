/**
 * Every phone field must say it is a phone field to the browser: type="tel" + autoComplete="tel" + inputMode="tel".
 * Register row (2026-11-15): the account phone field accepted a browser-autofilled EMAIL because it had none of them.
 * This scans the JSX of the admin, web, orders and marketing apps, so a new phone input that omits them fails here.
 *
 * A field is "a phone field" when its value/name/id/onChange mention phone, mobile or whatsapp-number
 * (placeholder, label and className text are ignored). Checkboxes, passwords, one-time codes and the
 * whatsapp MESSAGE text box are not phone fields.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const APPS = ['admin', 'web', 'orders', 'marketing'].map(a => join(ROOT, 'apps', a, 'src'));
const TAG = /<(input|Input)\b/g;
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '__tests__']);

function walk(dir: string, out: string[] = []): string[] {
  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx') && !/\.(test|spec)\./.test(e.name)) out.push(p);
  }
  return out;
}

/** The JSX opening tag starting at `start`, balancing `{}` so `=>` inside handlers does not end it. */
function openingTag(src: string, start: number): string {
  let depth = 0;
  for (let j = start; j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0 && src[j - 1] !== '=') return src.slice(start, j + 1);
  }
  return src.slice(start);
}

/** The text that identifies WHAT the field holds: the tag minus presentational attributes. */
function identity(tag: string): string {
  return tag
    .replace(/`[^`]*`/g, '') // template-literal ids such as `search-${mobile}` are not field names
    .replace(
      /\b(className|placeholder|label|aria-label|title|lang)=(\{[^}]*(\{[^}]*\}[^}]*)*\}|"[^"]*"|'[^']*')/g,
      ''
    )
    .replace(/placeholder=\{[\s\S]*?\}\s/g, '');
}

function isPhoneField(tag: string): boolean {
  if (/type=["'](checkbox|password|radio|hidden|file)["']/.test(tag)) return false;
  if (/autoComplete=["']one-time-code["']/.test(tag)) return false;
  const id = identity(tag);
  if (/whatsapp(Message|OptIn)/i.test(id) && !/whatsapp(Phone|Number)/i.test(id)) return false;
  return /phone|mobile|whatsapp/i.test(id);
}

const has = {
  type: (t: string) => /type=["']tel["']/.test(t) || /type=\{[^}]*['"]tel['"][^}]*\}/.test(t),
  inputMode: (t: string) => /inputMode=(["']tel["']|\{[^}]*['"]tel['"][^}]*\})/.test(t),
  autoComplete: (t: string) =>
    /autoComplete=(["']tel(-national)?["']|\{[^}]*['"]tel(-national)?['"][^}]*\})/.test(t),
};

describe('phone inputs declare type/inputMode/autoComplete tel', () => {
  const found: { where: string; tag: string }[] = [];
  for (const dir of APPS) {
    for (const file of walk(dir)) {
      const src = readFileSync(file, 'utf8');
      TAG.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = TAG.exec(src))) {
        const tag = openingTag(src, m.index);
        if (isPhoneField(tag)) {
          found.push({
            where: `${relative(ROOT, file)}:${src.slice(0, m.index).split('\n').length}`,
            tag,
          });
        }
      }
    }
  }

  it('finds the phone inputs (guards against the scanner going blind)', () => {
    expect(found.length).toBeGreaterThanOrEqual(20);
  });

  it('every phone input has type="tel"', () => {
    expect(found.filter(f => !has.type(f.tag)).map(f => f.where)).toEqual([]);
  });
  it('every phone input has inputMode="tel"', () => {
    expect(found.filter(f => !has.inputMode(f.tag)).map(f => f.where)).toEqual([]);
  });
  it('every phone input has autoComplete="tel"', () => {
    expect(found.filter(f => !has.autoComplete(f.tag)).map(f => f.where)).toEqual([]);
  });
});
