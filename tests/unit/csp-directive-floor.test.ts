/**
 * The CSP directives that `.zap/rules.tsv`'s `10055 IGNORE` now hides.
 *
 * ZAP rule 10055 covers CSP findings as a class. The 2026-07-15 triage FIXED
 * one of them — "CSP directives with no default-src fallback" — by adding
 * `base-uri`, `object-src` and `form-action` to all three apps. A different
 * 10055 finding (`unsafe-inline` / `unsafe-eval`) is a long-term Next.js debt
 * tracked in `docs/security/csp-hardening-plan.md`, and suppressing it means
 * suppressing the rule id — which silently takes the cover off the fix too.
 *
 * So the scan is no longer what guards those three directives. This is.
 * Deleting one from a next.config reddens here instead of going unnoticed
 * until someone re-reads a nightly report.
 *
 * Reading the config text rather than a running response on purpose: this is
 * the PR-blocking tier, and a network call has no place in it. The live
 * headers were verified against production separately (see the PR).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../..');

/** Every app that serves HTML and therefore owes a CSP. */
const CONFIGS = [
  'apps/web/next.config.js',
  'apps/admin/next.config.js',
  'apps/orders/next.config.js',
];

/**
 * The three directives the 2026-07-15 fix added. Each closes a distinct hole
 * that `default-src` does NOT cover, which is why ZAP flagged their absence:
 *  - base-uri    — a `<base>` injection re-points every relative URL
 *  - object-src  — <object>/<embed> are not covered by script-src
 *  - form-action — where a form may POST, not where scripts may load from
 */
const REQUIRED = ['base-uri', 'object-src', 'form-action'];

describe('CSP directive floor (what ZAP 10055 no longer watches)', () => {
  const present = CONFIGS.filter(c => existsSync(join(ROOT, c)));

  it('finds the configs (guards against an empty-set pass)', () => {
    // Without this, a renamed config would make every assertion below
    // vacuously true — the gate would report success having read nothing.
    expect(present.length).toBeGreaterThan(0);
    expect(present).toContain('apps/web/next.config.js');
  });

  it.each(CONFIGS.filter(c => existsSync(join(ROOT, c))))('%s', config => {
    const src = readFileSync(join(ROOT, config), 'utf8');
    // Only look at files that actually declare a CSP; an app that serves no
    // HTML owes none, and asserting on one it never had would be noise.
    if (!src.includes('Content-Security-Policy')) return;

    for (const directive of REQUIRED) {
      expect(
        src.includes(directive),
        `${config} no longer sets \`${directive}\` in its CSP. ZAP rule 10055 ` +
          `is IGNOREd in .zap/rules.tsv (for the unsafe-inline debt), so the ` +
          `nightly scan will NOT report this — which is why the assertion ` +
          `lives here. Restore the directive, or remove the 10055 suppression ` +
          `so the scan covers it again.`
      ).toBe(true);
    }
  });

  it('the 10055 suppression that makes this test load-bearing is still in place', () => {
    // If 10055 is ever un-suppressed, the scan covers this again and this
    // test becomes belt-and-braces rather than the only guard. Asserting the
    // link keeps the two files honest about which one is doing the work.
    const rules = readFileSync(join(ROOT, '.zap/rules.tsv'), 'utf8');
    const line = rules.split('\n').find(l => l.startsWith('10055\t'));
    expect(line, '.zap/rules.tsv no longer has a 10055 row').toBeTruthy();
    expect(line).toContain('IGNORE');
  });
});
