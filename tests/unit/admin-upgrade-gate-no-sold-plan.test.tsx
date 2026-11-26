// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({ useLocale: () => 'ar', useTranslations: () => (k: string) => k }));
vi.mock('@/components/ui/Button', () => ({
  Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}));
vi.mock('../../apps/admin/src/components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
import { FeatureUpgradeGate } from '../../apps/admin/src/components/FeatureUpgradeGate';

describe('STORE-QA-25 locked feature with no purchasable plan', () => {
  // Since "business has every feature" (#847) every registry feature is in a sold plan, so the no-sold-plan
  // branch is only reachable for a key the registry does not map to a plan (a platform-only / unknown feature).
  it('a feature in no sold plan: says so, no upgrade / see-plans CTA, contact only', () => {
    render(<FeatureUpgradeGate featureKey="platform.not-in-any-sold-plan" storeId="s1" />);
    expect(screen.getByTestId('no-sold-plan')).toBeTruthy();
    expect(screen.queryByText('seePlansCta')).toBeNull();
    expect(screen.queryByText('upgradeCta')).toBeNull();
    expect(screen.getByText('contactOnlyCta')).toBeTruthy();
  });
  it('a feature a sold plan unlocks keeps the upgrade CTA', () => {
    render(<FeatureUpgradeGate featureKey="inventory.multi_warehouse" storeId="s1" />);
    expect(screen.queryByTestId('no-sold-plan')).toBeNull();
    expect(screen.getByText('upgradeCta')).toBeTruthy();
  });
  it('the registry name matches the nav label (one name per screen)', async () => {
    const { FEATURE_REGISTRY } = await import('../../packages/shared/src/features');
    expect(FEATURE_REGISTRY.bundles.nameAr).toBe('مجموعات المنتجات');
  });
});

describe('STORE-QA-30 /team redirects to /staff', () => {
  it('next.config redirects /stores/:id/team to /stores/:id/staff', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('apps/admin/next.config.js', 'utf8');
    expect(src).toMatch(/source: '\/stores\/:id\/team',\s*destination: '\/stores\/:id\/staff'/);
  });
});
