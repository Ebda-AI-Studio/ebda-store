/** The admin's "Add just this feature" button and the API's add-on catalog must sell the same features (AI-ADDON-1). */
import { describe, expect, it } from 'vitest';
import { ADDON_FEATURE_KEYS } from '@ebda/shared';
import { ADDON_CATALOG } from '@api/services/billing/addon-catalog';
import { featureAddHref } from '../../apps/admin/src/lib/feature-add-link';

describe('add-on feature keys', () => {
  it('ADDON_FEATURE_KEYS equals the feature SKUs in ADDON_CATALOG', () => {
    const sold = Object.values(ADDON_CATALOG)
      .filter(i => i.kind === 'feature')
      .map(i => i.featureKey)
      .sort();
    expect([...ADDON_FEATURE_KEYS].sort()).toEqual(sold);
  });
  it('a buyable feature links to the add-ons page with its sku', () => {
    expect(featureAddHref('s 1', 'floating_widget')).toBe(
      '/stores/s%201/billing/addons?sku=feature%3Afloating_widget'
    );
  });
  it('a feature with no add-on gets no link, so the button is hidden', () => {
    expect(featureAddHref('s1', 'accounting.basic')).toBeNull();
  });
});
