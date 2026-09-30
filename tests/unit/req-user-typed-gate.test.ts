/**
 * Issue 2252 — `(req as any).user?.id` is always undefined: `req.user` is
 * `AuthPayload` (apps/api/src/middleware/auth.ts), which has `userId`, never
 * `id`. The `as any` cast is exactly what suppressed the compiler error, so
 * five accounting attribution columns (a purchase order's createdBy/
 * receivedBy, a manual journal entry's postedBy, an FX rate's recordedBy, a
 * rollup event's userId) were written NULL in production.
 *
 * The fix removes every cast so the typed Request augmentation catches the
 * next one. This gate keeps it that way: no API source file may read `user`
 * off an `any`-cast request, and nothing may read a `.id` off `req.user`.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '../../apps/api/src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sourceFiles(full);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [full] : [];
  });
}

const UNTYPED_USER = /\(req as any\)\.user|req\.user!?\??\.id\b/;

describe('req.user is read through its type (issue 2252)', () => {
  it('the pattern matches the defect shapes it exists for (positive control)', () => {
    expect(UNTYPED_USER.test('createdBy: (req as any).user?.id,')).toBe(true);
    expect(UNTYPED_USER.test('const id = req.user?.id;')).toBe(true);
    expect(UNTYPED_USER.test('createdBy: req.user?.userId,')).toBe(false);
  });

  it('no apps/api source reads user off an any-cast request, or a .id off req.user', () => {
    const files = sourceFiles(ROOT);
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.flatMap(file =>
      readFileSync(file, 'utf8')
        .split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => UNTYPED_USER.test(line))
        .map(({ n, line }) => `${relative(ROOT, file)}:${n}: ${line.trim()}`)
    );
    expect(offenders).toEqual([]);
  });
});
