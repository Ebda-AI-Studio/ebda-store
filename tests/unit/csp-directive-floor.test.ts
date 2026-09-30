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

/**
 * Blank out `//` and `/* *\/` comment bodies so a comment that merely NAMES a
 * directive (or, as this repo's own next.config.js comments do, happens to
 * quote a directive's exact value while explaining why it's safe) cannot
 * satisfy an assertion meant to read the real, active config. String/template
 * literal CONTENTS pass through untouched and, crucially, are not scanned for
 * `//` — the CSP values here are full of `https://` — but are still tracked
 * so a `//` or `/*` inside one is never mistaken for a comment start.
 */
function stripJsComments(src: string): string {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') {
          out += src[i];
          i++;
        }
        out += src[i];
        i++;
      }
      out += src[i] ?? '';
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' ';
        i++;
      }
      out += '\n';
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      out += '  ';
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  ';
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

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
 *
 * Each is matched WITH its required value as one token
 * (`/base-uri\s+'self'/`, not a bare `includes('base-uri')`) — a plain
 * substring match is satisfied by a comment that merely NAMES the directive
 * (e.g. "base-uri, form-action and object-src must be explicit") even after
 * the real directive line below it is deleted.
 */
const REQUIRED: { directive: string; pattern: RegExp }[] = [
  { directive: 'base-uri', pattern: /base-uri\s+'self'/ },
  { directive: 'object-src', pattern: /object-src\s+'none'/ },
  { directive: 'form-action', pattern: /form-action\s+'self'/ },
];

describe('CSP directive floor (what ZAP 10055 no longer watches)', () => {
  const present = CONFIGS.filter(c => existsSync(join(ROOT, c)));

  it('finds the configs (guards against an empty-set pass)', () => {
    // Without this, a renamed config would make every assertion below
    // vacuously true — the gate would report success having read nothing.
    expect(present.length).toBeGreaterThan(0);
    expect(present).toContain('apps/web/next.config.js');
  });

  it.each(CONFIGS.filter(c => existsSync(join(ROOT, c))))('%s', config => {
    const raw = readFileSync(join(ROOT, config), 'utf8');
    // Assertions run against the comment-stripped source: a comment can name
    // a directive, or (as this repo's own next.config.js comments do) even
    // quote its exact value while explaining why it's safe, and either would
    // satisfy a check meant to read the real, active config.
    const src = stripJsComments(raw);
    // Every config in CONFIGS serves HTML (see the file docstring) and so
    // owes a CSP header outright. This is a POSITIVE assertion, not the
    // early-return it replaces: `.zap/rules.tsv` globally IGNOREs 10038
    // ("CSP header not set"), so a config that dropped the header entirely
    // would be invisible to the nightly scan too — this is the only gate
    // left standing for that regression.
    expect(
      src.includes('Content-Security-Policy'),
      `${config} no longer declares a Content-Security-Policy header at all. ` +
        `ZAP rule 10038 is globally IGNOREd in .zap/rules.tsv, so the nightly ` +
        `scan will NOT report this either.`
    ).toBe(true);

    for (const { directive, pattern } of REQUIRED) {
      expect(
        pattern.test(src),
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

  // Issue 2100: `.zap/rules.tsv` globally IGNOREs 10063 ("Permissions-Policy
  // not set") for static chunks. The IGNORE has no URL scope, so it also hides
  // the header going missing from the HTML routes that DO carry it — this is
  // the deterministic gate that replaced the one-off production curl.
  it.each(CONFIGS.filter(c => existsSync(join(ROOT, c))))(
    '%s declares a Permissions-Policy that denies geolocation/microphone/camera (ZAP 10063 is IGNOREd)',
    config => {
      const src = stripJsComments(readFileSync(join(ROOT, config), 'utf8'));
      const m = /key:\s*'Permissions-Policy',\s*value:\s*'([^']*)'/.exec(src);
      expect(
        m,
        `${config} no longer emits a Permissions-Policy header. ZAP rule 10063 is IGNOREd in ` +
          `.zap/rules.tsv, so the nightly scan will NOT report this.`
      ).toBeTruthy();
      for (const feature of ['geolocation=()', 'microphone=()', 'camera=()']) {
        expect(m![1], `${config}: Permissions-Policy lost \`${feature}\``).toContain(feature);
      }
    }
  );

  it('the 10063 suppression that makes the Permissions-Policy floor load-bearing is still in place', () => {
    const rules = readFileSync(join(ROOT, '.zap/rules.tsv'), 'utf8');
    const line = rules.split('\n').find(l => l.startsWith('10063\t'));
    expect(line, '.zap/rules.tsv no longer has a 10063 row').toBeTruthy();
    expect(line).toContain('csp-directive-floor.test.ts');
  });
});
