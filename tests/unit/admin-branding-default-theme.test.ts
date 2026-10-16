/**
 * FU46 M-3: the admin branding tab's DEFAULT_THEME stored a white primary ink on the default
 * orange (2.79:1). The ink is now derived from the primary like the storefront does
 * (`deriveBrandRoles`), so a theme saved from admin defaults reads at AA.
 */
import { describe, it, expect } from 'vitest';
import { contrastRatio, DEFAULT_THEME as SHARED_DEFAULT } from '@ebda/shared';
import { DEFAULT_THEME } from '../../apps/admin/src/app/stores/[id]/branding/_components/types';

describe('admin branding DEFAULT_THEME primary ink', () => {
  it('reads at AA (4.5:1) on the primary fill', () => {
    const ratio = contrastRatio(
      `hsl(${DEFAULT_THEME.primaryColor})`,
      `hsl(${DEFAULT_THEME.primaryForeground})`
    );
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
  it('agrees with the shared default', () => {
    expect(DEFAULT_THEME.primaryColor).toBe(SHARED_DEFAULT.primaryColor);
    expect(DEFAULT_THEME.primaryForeground).toBe(SHARED_DEFAULT.primaryForeground);
  });
});
