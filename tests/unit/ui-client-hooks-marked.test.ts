// 2026-10-26: #248 added packages/ui/src/search/useLiveSearch.ts (useEffect/useRef/useState) WITHOUT 'use client'.
// packages/ui/src/index.ts is a barrel imported from Server Components (apps/web cart/loading.tsx), so Next 16's
// build failed for the storefront ("importing a module that depends on useEffect into a React Server Component").
// CI's affected-only lane skipped the web build, so main stayed green. Any ui module that uses a stateful React
// hook must say so itself.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const UI = path.join(ROOT, 'packages/ui/src');
const STATEFUL =
  /\b(useState|useEffect|useRef|useCallback|useMemo|useReducer|useLayoutEffect|useContext|useTransition|useSyncExternalStore)\b/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|stories)\./.test(e.name)) out.push(p);
  }
  return out;
}

describe("packages/ui: stateful hooks need 'use client'", () => {
  it('every module importing a stateful React hook starts with the directive', () => {
    const offenders = walk(UI)
      .filter(f => {
        const src = fs.readFileSync(f, 'utf8');
        const imp = /import\s*\{([^}]*)\}\s*from\s*'react'/g;
        let m: RegExpExecArray | null;
        let uses = false;
        while ((m = imp.exec(src))) if (STATEFUL.test(m[1])) uses = true;
        return uses && !/^\s*['"]use client['"]/.test(src);
      })
      .map(f => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});
