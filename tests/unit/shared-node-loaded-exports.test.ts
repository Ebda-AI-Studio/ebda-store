import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `node apps/api/dist/index.js` (CI "Start API server", the API is CommonJS) resolves `@ebda/shared/<sub>` itself. A subpath
 * whose export has no `require`/`import` condition is loaded from raw `src/*.ts`, and plain Node cannot resolve that file's
 * own relative imports (`./brand` → ERR_UNSUPPORTED_DIR_IMPORT, `./x` → ERR_MODULE_NOT_FOUND): the API never starts
 * (PR #395). Bundlers accept it, so only CI saw it. Rule: every subpath the API imports either maps `require` to `dist/`
 * (as `./qr/schema` does) or has no relative imports at all.
 */
const repo = resolve(__dirname, '../..');
const shared = join(repo, 'packages/shared');
const exportsMap = JSON.parse(readFileSync(join(shared, 'package.json'), 'utf8')).exports as Record<
  string,
  string | Record<string, string>
>;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap(f => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.ts$/.test(f) ? [p] : [];
  });
const apiSubpaths = [
  ...new Set(
    walk(join(repo, 'apps/api/src')).flatMap(f =>
      [...readFileSync(f, 'utf8').matchAll(/from '@ebda\/shared\/([^']+)'/g)].map(m => `./${m[1]}`)
    )
  ),
].sort();

/** Value (not `import type`) relative imports of a source file: these must resolve at runtime. */
const valueRelativeImports = (file: string): string[] =>
  [...readFileSync(file, 'utf8').matchAll(/^import (?!type )[^;]*?from '(\.{1,2}\/[^']*)'/gm)].map(
    m => m[1]
  );

export const problem = (subpath: string): string | null => {
  const target = exportsMap[subpath];
  if (target === undefined) return `${subpath} is not in the @ebda/shared exports map`;
  if (typeof target === 'string' || target.require || target.import) return null;
  const rel = valueRelativeImports(join(shared, target.default));
  return rel.length
    ? `${subpath} loads raw src with relative imports ${rel.join(', ')}: add "require": "./dist/…js"`
    : null;
};

describe('@ebda/shared subpaths the API loads under plain Node', () => {
  it('finds the API imports to check', () => {
    expect(apiSubpaths).toContain('./contact-enquiry');
  });
  it.each(apiSubpaths)('%s resolves under Node', subpath => {
    expect(problem(subpath)).toBeNull();
  });
  it('negative control: a src-only subpath with a relative import is flagged', () => {
    const saved = exportsMap['./contact-enquiry'];
    exportsMap['./contact-enquiry'] = {
      types: './src/contact-enquiry.ts',
      default: './src/contact-enquiry.ts',
    };
    try {
      expect(problem('./contact-enquiry')).toMatch(/relative imports \.\/brand/);
    } finally {
      exportsMap['./contact-enquiry'] = saved;
    }
  });
});
