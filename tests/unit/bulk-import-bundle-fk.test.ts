/**
 * P1-4 (final review): the bundle-FK defect class was swept into the three
 * variant delete sites and the permanent bulk product delete, but NOT into
 * the CSV product import.
 *
 * `createVariantsForProductTx` re-imports variants with replace semantics —
 * `productVariant.deleteMany` first. `bundle_items.variant_id` is ON DELETE
 * RESTRICT, so a product whose variant a bundle pins raised P2003 INSIDE the
 * batch transaction: the batch rolled back and every unrelated product in the
 * same CSV was lost with it, under the global handler's generic "A referenced
 * record does not exist" — with no mention of a bundle.
 *
 * The fix has two halves and both are asserted here: the plan skips only the
 * affected parent (so unrelated rows survive) and its message names the
 * product AND the bundles, and the delete site still converts the residual
 * race into an actionable `VARIANT_USED_IN_BUNDLE` rather than a generic 500.
 */

import { describe, it, expect } from 'vitest';
import { Prisma } from '@ebda/database';
import {
  planBundlePinnedVariantSkips,
  variantsPinnedByBundleMessage,
  throwIfBundleFkViolation,
  bundleFkViolationKind,
} from '@api/lib/bundle-fk-errors';
import { AppError } from '@api/middleware/error-handler';

describe('planBundlePinnedVariantSkips', () => {
  const parents = new Map([
    ['SKU-BUNDLED', 'prod-bundled'],
    ['SKU-FREE', 'prod-free'],
    ['SKU-ALSO-FREE', 'prod-also-free'],
  ]);

  it('skips ONLY the parent whose variant a bundle pins', () => {
    const skips = planBundlePinnedVariantSkips(parents, [
      { productId: 'prod-bundled', bundle: { name: 'Ramadan Box' } },
    ]);

    expect(skips.map(s => s.parentSku)).toEqual(['SKU-BUNDLED']);
    // The two unrelated parents keep their variant rows — that is the half
    // that stops one bundled product taking the whole CSV down.
    expect(skips.map(s => s.parentSku)).not.toContain('SKU-FREE');
    expect(skips.map(s => s.parentSku)).not.toContain('SKU-ALSO-FREE');
  });

  it('names the product AND every bundle that pins it, deduped and ordered', () => {
    const skips = planBundlePinnedVariantSkips(parents, [
      { productId: 'prod-bundled', bundle: { name: 'Ramadan Box' } },
      { productId: 'prod-bundled', bundle: { name: 'Ramadan Box' } },
      { productId: 'prod-bundled', bundle: { name: 'Eid Hamper' } },
    ]);

    expect(skips).toHaveLength(1);
    expect(skips[0].bundleNames).toEqual(['Eid Hamper', 'Ramadan Box']);
    expect(skips[0].message).toContain('SKU-BUNDLED');
    expect(skips[0].message).toContain('Ramadan Box');
    expect(skips[0].message).toContain('Eid Hamper');
    // And it tells the merchant the rest of the file was fine.
    expect(skips[0].message).toMatch(/rest of the file was imported/i);
  });

  it('skips nothing when no bundle pins any of the parents', () => {
    expect(planBundlePinnedVariantSkips(parents, [])).toEqual([]);
  });

  it('ignores a bundle pinning a product the file does not touch', () => {
    const skips = planBundlePinnedVariantSkips(parents, [
      { productId: 'prod-elsewhere', bundle: { name: 'Other Box' } },
    ]);
    expect(skips).toEqual([]);
  });

  it('always names a bundle, even if the name came back empty', () => {
    expect(variantsPinnedByBundleMessage('SKU-X', [])).toContain('a bundle');
  });
});

describe('the variant delete still reports the residual race actionably', () => {
  const p2003 = new Prisma.PrismaClientKnownRequestError('FK violation', {
    code: 'P2003',
    clientVersion: 'test',
    meta: { field_name: 'bundle_items_variant_id_fkey (index)' },
  });

  it('classifies the constraint the CSV import would trip', () => {
    expect(bundleFkViolationKind(p2003)).toBe('variant');
  });

  it('converts it into VARIANT_USED_IN_BUNDLE, not a generic 500', () => {
    try {
      throwIfBundleFkViolation(p2003);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('VARIANT_USED_IN_BUNDLE');
    }
  });

  it('leaves every other error for the caller to rethrow unchanged', () => {
    expect(() => throwIfBundleFkViolation(new Error('boom'))).not.toThrow();
  });
});
