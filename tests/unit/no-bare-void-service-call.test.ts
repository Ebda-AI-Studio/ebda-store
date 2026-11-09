/**
 * No bare `void <Class>.<method>(...)` post-response side effect in apps/api/src.
 *
 * A fire-and-forget started inside a handler inherits the request's AsyncLocalStorage database
 * lease. Once the response finishes and the lease is released, its first Prisma call dies with
 * P2028 inside the caller's swallowed `.catch`: the welcome / verification / duplicate-registration
 * mail, the receipt cleanup, the card-testing counter simply never happen (the provisioning welcome
 * mail never reached EmailService.sendForStore, red in CI, 2026-11-09). Post-response work goes
 * through `deferAfterTenantCommit()` (lib/after-tenant-commit.ts), or is awaited when the response
 * depends on it.
 *
 * Scope: the `void Class.method(` shape (services, guards). Lowercase helpers are out of scope here;
 * the ones that touch the database defer internally (r2-cleanup, recordPaymentSettled).
 *
 * Mutation record: reverting `deferAfterTenantCommit(...)` to `void EmailService.sendWelcome(...)`
 * in services/provisioning.service.ts turns this test red (see the PR).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sourceFiles, stripComments } from './helpers/source-scan';

const ROOT = path.resolve(__dirname, '../..');

/** `relative/path.ts::Class.method` -> why a bare void is intentional. Keep empty unless justified. */
export const ALLOWED: Record<string, string> = {};

const RE = /\bvoid\s+(?!Promise\b)([A-Z][A-Za-z0-9_]*\.[A-Za-z0-9_]+)\s*\(/g;

export function findBareVoidServiceCalls(src: string): Array<{ line: number; call: string }> {
  const out: Array<{ line: number; call: string }> = [];
  let m: RegExpExecArray | null;
  RE.lastIndex = 0;
  while ((m = RE.exec(src))) {
    out.push({ line: src.slice(0, m.index).split('\n').length, call: m[1] });
  }
  return out;
}

describe('no bare void <Class>.<method>( in apps/api/src', () => {
  it('detects the pattern (negative control)', () => {
    expect(findBareVoidServiceCalls('x();\n  void EmailService.sendWelcome(a).catch(e);')).toEqual([
      { line: 2, call: 'EmailService.sendWelcome' },
    ]);
    expect(findBareVoidServiceCalls('void deferAfterTenantCommit("n", () => A.b());')).toEqual([]);
  });

  it('finds none outside the allowlist', () => {
    const api = path.join(ROOT, 'apps/api/src') + path.sep;
    const bad: string[] = [];
    for (const f of sourceFiles()) {
      if (!f.startsWith(api) || f.includes(`${path.sep}__tests__${path.sep}`)) continue;
      const rel = path.relative(ROOT, f);
      for (const h of findBareVoidServiceCalls(stripComments(fs.readFileSync(f, 'utf8')))) {
        if (!ALLOWED[`${rel}::${h.call}`]) bad.push(`${rel}:${h.line} void ${h.call}(`);
      }
    }
    expect(
      bad,
      'wrap in deferAfterTenantCommit() (lib/after-tenant-commit.ts) or await it; allowlist with a reason only if intentional'
    ).toEqual([]);
  });
});
