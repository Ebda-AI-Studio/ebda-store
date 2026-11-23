/**
 * G12 class guard: every user-typed phone <input> in admin + storefront is `type="tel"` with `inputMode="tel"` and
 * `autoComplete="tel"` (so mobiles open the keypad and autofill works), and the shared Zod schema the API uses
 * rejects an e-mail or a name as a phone number.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPlausiblePhone, phoneOrBlankSchema, phoneSchema } from '@ebda/shared';

const ROOT = path.resolve(__dirname, '../..');

function walk(dir: string, out: string[]): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.next', 'dist', 'dist-cf', '.open-next'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
  }
  return out;
}

describe('phone inputs (G12)', () => {
  const files = ['apps/admin/src', 'apps/web/src', 'apps/marketing/src'].flatMap(d =>
    walk(path.join(ROOT, d), [])
  );
  const phoneInputs: Array<{ file: string; el: string }> = [];
  for (const file of files) {
    const s = fs.readFileSync(file, 'utf8');
    for (const m of s.matchAll(/<(?:input|Input)\b[\s\S]*?\/>/g)) {
      const el = m[0];
      // identify a phone field by its id/name/value binding, not by incidental words in a placeholder
      const isPhone =
        /(?:id|name)=["'][^"']*(?:phone|mobile)[^"']*["']/i.test(el) ||
        /value=\{[^}]*(?:phone|Phone|mobile)[^}]*\}/.test(el);
      // the step-up password and the 6-digit code that sit in the phone panel are not phone fields
      const notPhone = /type="password"|inputMode="numeric"/.test(el);
      if (isPhone && !notPhone) phoneInputs.push({ file: path.relative(ROOT, file), el });
    }
  }

  it('finds the phone inputs at all (guards the scanner itself)', () => {
    expect(phoneInputs.length).toBeGreaterThan(15);
  });

  it('every phone input has type=tel, inputMode=tel and autoComplete=tel', () => {
    const bad = phoneInputs
      .filter(
        ({ el }) =>
          !/type=("tel"|\{[^}]*'tel'[^}]*\})/.test(el) ||
          !/inputMode=/.test(el) ||
          !/autoComplete=/.test(el)
      )
      .map(x => x.file);
    expect(bad).toEqual([]);
  });
});

describe('shared phone schema (G12)', () => {
  it('rejects an e-mail, a name and too-short digits', () => {
    for (const v of ['a@b.com', 'ahmad', '12345', '+++', '0100 abc 4567']) {
      expect(isPlausiblePhone(v), v).toBe(false);
      expect(phoneSchema.safeParse(v).success, v).toBe(false);
    }
  });
  it('accepts Egyptian, international and Arabic-digit numbers', () => {
    for (const v of [
      '01001234567',
      '+20 100 123 4567',
      '(0100) 123-4567',
      '+14155550123',
      '٠١٠٠١٢٣٤٥٦٧',
    ]) {
      expect(phoneSchema.safeParse(v).success, v).toBe(true);
    }
  });
  it('phoneOrBlank lets a cleared box through', () => {
    expect(phoneOrBlankSchema.safeParse('').success).toBe(true);
    expect(phoneOrBlankSchema.safeParse('x@y.z').success).toBe(false);
  });
});
