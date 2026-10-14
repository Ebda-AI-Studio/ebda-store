/**
 * `inert` is a BOOLEAN attribute under the React the storefront runs on (Next's vendored
 * React 19): `inert: ''` renders NOTHING (React warns "Received an empty string for a boolean
 * attribute inert"), so the collapsed mobile menus of the minimal, classic and elegant headers
 * were never inert and their links stayed in the tab order. Found in the Phase S looks browser
 * check (every look renders the minimal header). The unit tests render with React 18, where
 * `''` happens to work, so this pins the source form instead: `true`, like BottomTabBar.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [p] : [];
  });
}

describe('storefront inert attribute', () => {
  it('no storefront source sets inert to an empty string (React 19 renders it as false)', () => {
    const root = join(__dirname, '../../apps/web/src');
    const offenders = files(root).filter(f =>
      /\binert\s*[:=]\s*(''|""|\{\s*''\s*\})/.test(readFileSync(f, 'utf8'))
    );
    expect(offenders).toEqual([]);
  });
});
