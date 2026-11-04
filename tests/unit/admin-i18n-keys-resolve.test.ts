/**
 * Every static translation key the admin calls must resolve to a STRING in
 * both en.json and ar.json.
 *
 * next-intl renders a missing key as the raw key path, so a typo or a lost key
 * ships as `orders.list.agentBadge` on the merchant's screen with no error, no
 * type check and no failing test. Key parity (admin-i18n-key-parity.test.ts)
 * cannot see it: a key missing from BOTH files is still "in parity".
 *
 * Two real defects this catches (2026-09-25):
 *  - a translation pass set `orders.layout.sections.hero` to the string "Hero"
 *    for a new label, which silently replaced the whole `sections.hero` object
 *    and orphaned 81 page-builder keys (a key cannot be a leaf and a group);
 *  - five keys already missing on main (`common.actions`, `common.deactivate`,
 *    `orders.list.agentBadge`, `insights.dashboard.asOf`,
 *    `aiTools.jobKind.descriptionRevert`) plus `users.role` used as a label
 *    while it is a group of role names.
 *
 * Scope: calls whose key is a string literal, bound through
 * `const x = useT('ns')` / `useTranslations('ns')`, resolved against the
 * nearest preceding binding of that name in the same file. Template-literal
 * keys (`t(\`role.${r}\`)`) are dynamic and skipped.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ADMIN_SRC = join(__dirname, '../../apps/admin/src');
// Keys a track has written to i18n/fragments/<track>.<locale>.json resolve too: the integrator merges them into
// the message files at the end (scripts/merge-i18n-fragments.mjs), so a track's PR must not fail before that.
function loadMessages(locale: 'en' | 'ar'): unknown {
  const base = JSON.parse(readFileSync(join(ADMIN_SRC, `i18n/messages/${locale}.json`), 'utf8'));
  const dir = join(ADMIN_SRC, 'i18n/fragments');
  if (!existsSync(dir)) return base;
  const overlay = (dst: Record<string, unknown>, src: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(src)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const cur = dst[k];
        dst[k] = overlay(
          cur && typeof cur === 'object' ? (cur as Record<string, unknown>) : {},
          v as Record<string, unknown>
        );
      } else dst[k] = v;
    }
    return dst;
  };
  for (const f of readdirSync(dir).filter(n => n.endsWith(`.${locale}.json`))) {
    overlay(base, JSON.parse(readFileSync(join(dir, f), 'utf8')));
  }
  return base;
}
const en = loadMessages('en');
const ar = loadMessages('ar');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : walk(p);
    return /\.(tsx?|jsx?)$/.test(name) && !/\.test\./.test(name) ? [p] : [];
  });
}

function lookup(messages: unknown, path: string): unknown {
  let node: unknown = messages;
  for (const part of path.split('.')) {
    if (node === null || typeof node !== 'object' || !(part in node)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** Strip // and /* *\/ comments so a key mentioned in prose isn't read as a call. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function unresolvedKeys(): string[] {
  const problems: string[] = [];
  const bindRe = /const\s+(\w+)\s*=\s*use(?:T|Translations)\(\s*(?:(['"])([^'"]*)\2)?\s*\)/g;
  for (const file of walk(ADMIN_SRC)) {
    const src = stripComments(readFileSync(file, 'utf8'));
    const binds = [...src.matchAll(bindRe)].map(m => ({
      at: m.index ?? 0,
      name: m[1],
      ns: m[3] ?? '',
    }));
    for (const name of new Set(binds.map(b => b.name))) {
      const callRe = new RegExp(
        `(?<![\\w.])${name}(?:\\.rich|\\.raw|\\.markup)?\\(\\s*(['"])([^'"]+)\\1`,
        'g'
      );
      for (const m of src.matchAll(callRe)) {
        const at = m.index ?? 0;
        const bind = binds.filter(b => b.name === name && b.at < at).pop();
        if (!bind) continue;
        const key = bind.ns ? `${bind.ns}.${m[2]}` : m[2];
        const line = src.slice(0, at).split('\n').length;
        for (const [loc, messages] of [
          ['en', en],
          ['ar', ar],
        ] as const) {
          const value = lookup(messages, key);
          if (typeof value !== 'string') {
            problems.push(
              `${file.replace(ADMIN_SRC, 'apps/admin/src')}:${line} ${key} (${loc}: ${value === undefined ? 'missing' : 'not a string'})`
            );
          }
        }
      }
    }
  }
  return problems;
}

describe('admin i18n: every static t() key resolves to a string in en and ar', () => {
  it('has no missing or non-leaf keys', () => {
    expect(unresolvedKeys()).toEqual([]);
  });
});
