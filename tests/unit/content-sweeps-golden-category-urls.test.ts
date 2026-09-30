/**
 * Regression for #1888: the llms-txt golden eval fixture asserted the DEAD
 * `/categories/<slug>` URL shape for category links — apps/web has no
 * `/categories/[slug]` route, so every one of those links 404'd on every
 * store that ran the sweep (A4-2, 2026-09-22 AEO audit). bulk-ai-geo.ts's
 * prompt was fixed to emit `/products?category=<slug>`, but the golden
 * fixture still held up the dead shape as "correct" — a regression back to
 * generating `/categories/<slug>` would have passed this eval gate again.
 */
import { describe, it, expect } from 'vitest';
import { CONTENT_SWEEPS_GOLDEN } from '@api/lib/ai/eval/fixtures/golden/content-sweeps';

describe('llms-txt golden fixture category URLs (#1888)', () => {
  const testCase = CONTENT_SWEEPS_GOLDEN.find(c => c.id === 'llms-txt-basic-store');

  it('exists', () => {
    expect(testCase).toBeDefined();
  });

  it('never asserts the dead /categories/<slug> URL shape', () => {
    const output = String(testCase?.output ?? '');
    expect(output).not.toMatch(/\/categories\/[a-z0-9-]+/);
  });

  it('asserts the real /products?category=<slug> URL shape for every category', () => {
    const output = String(testCase?.output ?? '');
    expect(output).toContain('/products?category=kitchen-dining');
    expect(output).toContain('/products?category=home-decor');
  });
});
