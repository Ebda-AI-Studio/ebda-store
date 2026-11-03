// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const features = { isLoading: false, enabled: false };
vi.mock('../../apps/admin/src/hooks/useFeatures', () => ({
  useFeatures: () => ({ isEnabled: () => features.enabled, isLoading: features.isLoading, refresh: async () => {} }),
}));
vi.mock('../../apps/admin/src/lib/auth', () => ({ useAuth: () => ({ user: { role: 'store_admin' } }) }));
vi.mock('next-intl', () => ({ useLocale: () => 'ar' }));
vi.mock('../../apps/admin/src/components/FeatureUpgradeGate', () => ({
  FeatureUpgradeGate: ({ featureKey }: { featureKey: string }) => <div data-testid="locked">{featureKey}</div>,
}));
vi.mock('../../apps/admin/src/components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
import { PlanGate } from '../../apps/admin/src/components/PlanGate';

beforeEach(() => {
  features.isLoading = false;
  features.enabled = false;
});

describe('<PlanGate>', () => {
  it('renders the locked card instead of the page when the entitlement is off (page never mounts)', () => {
    const mounted = vi.fn();
    const Page = () => (mounted(), <div>page</div>);
    render(
      <PlanGate storeId="s1" featureKey="inventory.backorder">
        <Page />
      </PlanGate>
    );
    expect(screen.getByTestId('locked').textContent).toBe('inventory.backorder');
    expect(mounted).not.toHaveBeenCalled();
  });

  it('does not mount the page while entitlements load on a gated route', () => {
    features.isLoading = true;
    const mounted = vi.fn();
    const Page = () => (mounted(), <div>page</div>);
    render(
      <PlanGate storeId="s1" featureKey="loyalty">
        <Page />
      </PlanGate>
    );
    expect(mounted).not.toHaveBeenCalled();
  });

  it('renders the page when enabled, and on ungated routes', () => {
    features.enabled = true;
    const { rerender } = render(
      <PlanGate storeId="s1" featureKey="loyalty">
        <div>page</div>
      </PlanGate>
    );
    expect(screen.getByText('page')).toBeTruthy();
    features.enabled = false;
    rerender(
      <PlanGate storeId="s1" featureKey={null}>
        <div>free page</div>
      </PlanGate>
    );
    expect(screen.getByText('free page')).toBeTruthy();
  });

  it('maps a 402/403 that reaches the page to a locked state with no raw text', () => {
    features.enabled = true;
    render(
      <PlanGate storeId="s1" featureKey="accounting.basic" error={{ status: 403, code: 'FEATURE_DISABLED' }}>
        <div>page</div>
      </PlanGate>
    );
    expect(screen.getByTestId('locked')).toBeTruthy();
    const none = render(
      <PlanGate storeId="s1" error={{ status: 402 }}>
        <div>page2</div>
      </PlanGate>
    );
    expect(none.container.textContent).toMatch(/باقتك/);
    expect(none.container.textContent).not.toMatch(/Request failed|Feature not available/);
  });

  it('lets a real (non-plan) error through to the page', () => {
    features.enabled = true;
    render(
      <PlanGate storeId="s1" featureKey="loyalty" error={{ status: 500 }}>
        <div>page</div>
      </PlanGate>
    );
    expect(screen.getByText('page')).toBeTruthy();
  });
});
