/**
 * GHSA-mfr8-8qww-v76h (next, moderate): vulnerable >=16.3.0 <=16.4.4, patched 16.4.5.
 * Every app that declares `next` must require at least the patched release, and the lockfile
 * must not resolve below it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const read = (p: string) => JSON.parse(readFileSync(resolve(root, p), 'utf8'));
const num = (v: string) =>
  v
    .replace(/^[^\d]*/, '')
    .split('.')
    .map(Number);
const atLeast = (v: string, floor: string) => {
  const [a, b] = [num(v), num(floor)];
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};

describe('next patched floor (GHSA-mfr8-8qww-v76h)', () => {
  const apps = ['admin', 'web', 'orders', 'marketing'];
  it.each(apps)('apps/%s requires next >= 16.4.5', app => {
    expect(atLeast(read(`apps/${app}/package.json`).dependencies.next, '16.4.5')).toBe(true);
  });
  it('lockfile resolves next >= 16.4.5', () => {
    const lock = read('package-lock.json');
    expect(atLeast(lock.packages['node_modules/next'].version, '16.4.5')).toBe(true);
  });
});
