import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// S4-14 / POSTHOG-EU-1: the privacy text says EU and production sets the EU host; the CSP must not allow the US ones.
describe('CSP allows PostHog EU only', () => {
  for (const app of ['admin', 'web']) {
    const src = readFileSync(join(__dirname, `../../apps/${app}/src/lib/csp.ts`), 'utf8');
    it(`${app}: no US PostHog host, EU hosts still allowed`, () => {
      expect(src).not.toMatch(/(^|[^e])us(-assets)?\.i\.posthog\.com/);
      expect(src).toMatch(/eu\.i\.posthog\.com/);
      expect(src).toMatch(/eu-assets\.i\.posthog\.com/);
    });
  }
});
