import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain .mjs helper
import { heroFile } from '../../scripts/storedemo/mock-heroes.mjs';
import { getLook } from '../../packages/shared/src/looks/registry';

const IMG = path.resolve(__dirname, '../../apps/marketing/public/looks/img');

describe("showroom hero photos are the mock-ups' own", () => {
  const MAP: [string, string, string][] = [
    ['jasmine', 'apothecary', 'ja'],
    ['jasmine', 'bloom', 'jb'],
    ['jasmine', 'clinic', 'jc'],
    ['dahab', 'worn', 'da'],
    ['dahab', 'workshop', 'db'],
    ['dahab', 'giftbox', 'dc'],
    ['lamma', 'table', 'la'],
    ['qamar', 'atelier', 'qa'],
    ['souq', 'night', 'sb'],
  ];
  it.each(MAP)('%s.%s uses mock/%s__hero.webp, a file the mock-ups ship', (tpl, key, code) => {
    expect(getLook(`${tpl}.${key}`), `${tpl}.${key}`).toBeTruthy();
    expect(heroFile(tpl, key, 'fallback.webp')).toBe(`mock/${code}__hero.webp`);
    expect(existsSync(path.join(IMG, `${code}__hero.webp`))).toBe(true);
  });
  it('a look without a mock hero keeps its own file', () => {
    expect(heroFile('qamar', 'lookbook', 'hero-lookbook.webp')).toBe('hero-lookbook.webp');
  });
  it('every showroom home document reads its hero through heroFile', () => {
    for (const f of ['jasmine', 'dahab', 'lamma', 'souq', 'qamar'])
      expect(
        readFileSync(path.resolve(__dirname, `../../scripts/storedemo/${f}-home.mjs`), 'utf8')
      ).toContain('heroFile(');
  });
});
