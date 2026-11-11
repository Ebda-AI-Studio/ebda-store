import { randomInt } from 'node:crypto';

/**
 * A random 8-character suffix for test store slugs that can never spell a protected brand.
 * `crypto.randomUUID().slice(0, 8)` is hex, and the slug validator normalises (b/8, o/0, ...) before matching the
 * protected brand list, so about 1 run in 500 produced a suffix like `...cbe` / `...ebda` and a store create
 * answered 400 SLUG_PROTECTED (main's Integration job, 2026-11-11, 5 look tests at once). Letters with no
 * look-alike digit and no brand made of them: tests/unit/safe-run.test.ts proves no match over 20,000 draws.
 */
const ALPHABET = 'qxzkwj';
export const safeRun = (): string =>
  Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
