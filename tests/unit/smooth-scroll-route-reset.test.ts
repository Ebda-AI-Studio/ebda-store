/**
 * A Next app whose stylesheet sets `scroll-behavior: smooth` on `html` must put
 * `data-scroll-behavior="smooth"` on its root `<html>`.
 *
 * Why: after a client navigation Next's router sets `scrollTop = 0` and then checks that the new
 * page's top is in view. It only switches smooth scrolling off for that moment when the attribute
 * is present (next/dist/shared/lib/router/utils/disable-smooth-scroll.js). Without it the reset is
 * an animation that has not moved yet, the check fails, the router calls `scrollIntoView()` on the
 * page's nodes and the two smooth scrolls race. Measured on ebda.app (2026-11-10): opening a service
 * page from the phone menu ended at the footer (y 9071 of 9592).
 *
 * The apps are discovered, not listed, so a new Next app with smooth scrolling is covered too.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '../..');
const APPS = join(ROOT, 'apps');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** True when a stylesheet turns smooth scrolling on for the document (`html` or `:root`). */
export function setsSmoothOnHtml(css: string): boolean {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return /(?:^|[\s,{}])(?:html|:root)\s*\{[^}]*scroll-behavior:\s*smooth/.test(noComments);
}

/** The opening tags of every JSX `<html …>` in a source file (a tag starts its own line). */
export function htmlOpenTags(src: string): string[] {
  const tags: string[] = [];
  const re = /^[ \t]*<html\b[\s\S]*?(?=<body\b|<head\b)/gm;
  for (const m of src.matchAll(re)) tags.push(m[0]);
  return tags;
}

const HAS_ATTR = /data-scroll-behavior="smooth"/;

function nextApps(): string[] {
  return readdirSync(APPS).filter(name => {
    const pkg = join(APPS, name, 'package.json');
    if (!existsSync(pkg)) return false;
    const json = JSON.parse(readFileSync(pkg, 'utf8')) as { dependencies?: Record<string, string> };
    return Boolean(json.dependencies?.next) && existsSync(join(APPS, name, 'src'));
  });
}

describe('smooth scrolling and the router scroll reset', () => {
  it('the detectors can fail (known-bad and known-good samples)', () => {
    expect(setsSmoothOnHtml('html { scroll-behavior: smooth; }')).toBe(true);
    expect(
      setsSmoothOnHtml(
        '@media (prefers-reduced-motion: no-preference) {\n  html {\n    scroll-behavior: smooth;\n  }\n}'
      )
    ).toBe(true);
    expect(setsSmoothOnHtml('html { scroll-behavior: auto; }')).toBe(false);
    expect(setsSmoothOnHtml('.rail { scroll-behavior: smooth; }')).toBe(false);
    expect(setsSmoothOnHtml('/* html { scroll-behavior: smooth; } */')).toBe(false);

    const bad = '  return (\n    <html lang={lang} dir={dir}>\n      <body>';
    const good =
      '  return (\n    <html\n      lang={locale}\n      data-scroll-behavior="smooth"\n    >\n      <body>';
    expect(htmlOpenTags(bad)).toHaveLength(1);
    expect(HAS_ATTR.test(htmlOpenTags(bad)[0]!)).toBe(false);
    expect(HAS_ATTR.test(htmlOpenTags(good)[0]!)).toBe(true);
    // a mention in a comment is not an element
    expect(htmlOpenTags('// the same decision that picked `<html lang>`\n<body>')).toHaveLength(0);
  });

  const apps = nextApps();

  it('finds the Next apps', () => {
    expect(apps).toEqual(expect.arrayContaining(['admin', 'marketing', 'web']));
  });

  for (const app of apps) {
    const src = join(APPS, app, 'src');
    const files = walk(src);
    const smoothCss = files.filter(
      f => f.endsWith('.css') && setsSmoothOnHtml(readFileSync(f, 'utf8'))
    );
    if (smoothCss.length === 0) continue;

    it(`${app}: html scrolls smoothly, so the root <html> carries data-scroll-behavior="smooth"`, () => {
      // global-error.tsx replaces the root layout and loads no stylesheet, so no smooth scrolling there.
      const shells = files.filter(
        f =>
          f.endsWith('.tsx') &&
          !/\.test\.tsx$/.test(f) &&
          !f.endsWith('global-error.tsx') &&
          htmlOpenTags(readFileSync(f, 'utf8')).length > 0
      );
      expect(shells.length, `${app} has no root <html> element`).toBeGreaterThan(0);
      for (const f of shells) {
        for (const tag of htmlOpenTags(readFileSync(f, 'utf8'))) {
          expect(
            HAS_ATTR.test(tag),
            `${relative(ROOT, f)}: <html> is missing data-scroll-behavior="smooth"`
          ).toBe(true);
        }
      }
    });
  }

  it('covers the three apps that scroll smoothly today', () => {
    const smooth = apps.filter(app =>
      walk(join(APPS, app, 'src')).some(
        f => f.endsWith('.css') && setsSmoothOnHtml(readFileSync(f, 'utf8'))
      )
    );
    expect(smooth.sort()).toEqual(['admin', 'marketing', 'web']);
  });
});
