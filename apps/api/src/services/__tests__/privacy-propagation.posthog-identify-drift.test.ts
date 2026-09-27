/**
 * audit-followup #1885.
 *
 * `deletePostHogPerson` (privacy-propagation.service.ts) warns instead of
 * throwing when PostHog isn't configured, on the documented premise that
 * "nothing in this repo calls `posthog.identify(userId)` (verified
 * 2026-09-23 — every occurrence is a comment), so PostHog knows visitors
 * only by an anonymous distinct_id the server never learns." That premise
 * was checked by hand, once, and nothing kept checking it.
 *
 * The day someone wires a real `posthog.identify(...)` call in web, admin or
 * orders, that premise flips: PostHog WOULD then hold a person keyed by our
 * userId, and an unconfigured PostHog on erasure becomes a real data-
 * retention gap again, not a false alarm — `POSTHOG_ERASURE_REQUIRED` needs
 * to go back to `true` (with credentials configured) so a missing
 * credential fails loud. This test is the standing check: it greps the
 * three frontends for an EXECUTABLE (non-comment) `posthog.identify(` call
 * and fails, naming `POSTHOG_ERASURE_REQUIRED`, the moment one appears.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../../..');
const ROOTS = ['apps/web/src', 'apps/admin/src', 'apps/orders/src'];

// Matches the established repo convention (tests/unit/platform-root-redirect.test.ts):
// strip block comments and full-line `//` comments before asserting on source.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function collectSourceFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) {
      collectSourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.(test|spec)\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
}

describe('posthog.identify( drift guard (audit-followup #1885)', () => {
  it('no executable posthog.identify( call exists yet in web/admin/orders', () => {
    const offenders: string[] = [];

    for (const root of ROOTS) {
      const files: string[] = [];
      collectSourceFiles(join(REPO_ROOT, root), files);
      for (const file of files) {
        const code = stripComments(readFileSync(file, 'utf8'));
        if (/posthog\.identify\(/.test(code)) {
          offenders.push(file);
        }
      }
    }

    const message = offenders.length
      ? `Found executable posthog.identify( in: ${offenders.join(', ')}. This flips the ` +
        'precondition documented in apps/api/src/services/privacy-propagation.service.ts ' +
        '(deletePostHogPerson warns instead of throwing because nothing calls identify()). ' +
        'Set POSTHOG_ERASURE_REQUIRED=true (with POSTHOG_PERSONAL_API_KEY/POSTHOG_PROJECT_ID ' +
        'configured) so a missing credential fails loud again, and update the comments in ' +
        'privacy-propagation.service.ts + PostHogProvider.tsx that describe this as unwired.'
      : undefined;

    expect(offenders, message).toEqual([]);
  });
});
