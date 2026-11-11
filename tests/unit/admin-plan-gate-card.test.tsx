// @vitest-environment jsdom
/**
 * A plan refusal on a page load (402 PLAN_LIMIT_REACHED / 403 FEATURE_DISABLED) renders the upgrade card, never the
 * destructive error + "try again" (live QA 2026-11-11: insights/cohorts|funnel|segments). Real crashes keep the shell and
 * never print the JS message. Locked nav items carry a lock badge; unsold features stay hidden.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'store-1' }),
  usePathname: () => '/',
}));
vi.mock('next-intl', () => ({ useLocale: () => 'ar', useTranslations: () => (k: string) => k }));
vi.mock('../../apps/admin/src/i18n/useT', () => ({
  useT: () => (key: string, vars?: Record<string, string>) =>
    vars ? `${key}:${Object.values(vars).join(',')}` : key,
}));
vi.mock('../../apps/admin/src/components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="shell">{children}</div>
  ),
}));

import { ErrorState } from '../../apps/admin/src/components/ErrorState';
import { planGateFor, registerPlanGate } from '../../apps/admin/src/lib/plan-gate-registry';
import StoreRouteError from '../../apps/admin/src/app/stores/[id]/error';
import { navFeatureState } from '../../apps/admin/src/lib/nav-lock';

const MSG = 'التحليلات المتقدمة مش متاحة في باقتك. اعمل ترقية لباقتك عشان تفتحها.';
const details = {
  limitKey: 'analyticsTier',
  required: 'advanced',
  upgradeTo: { code: 'business', nameAr: 'بيزنس', nameEn: 'Business' },
};

afterEach(cleanup);

describe('plan refusal registry', () => {
  it('registers only plan refusals', () => {
    expect(registerPlanGate('a', { status: 402, code: 'PLAN_LIMIT_REACHED', details })).toBe(true);
    expect(registerPlanGate('b', { status: 403, code: 'FEATURE_DISABLED' })).toBe(true);
    expect(registerPlanGate('c', { status: 403, code: 'FORBIDDEN' })).toBe(false);
    expect(registerPlanGate('d', { status: 500, code: 'SERVER_ERROR' })).toBe(false);
    expect(planGateFor('a')?.status).toBe(402);
    expect(planGateFor('c')).toBeNull();
    expect(planGateFor(null)).toBeNull();
  });
});

describe('ErrorState', () => {
  it('renders the upgrade card for a plan refusal: what it unlocks, which plan, billing link, no retry', () => {
    registerPlanGate(MSG, { status: 402, code: 'PLAN_LIMIT_REACHED', details });
    render(<ErrorState message={MSG} onRetry={() => {}} />);
    expect(screen.getByText('titleAnalyticsTier')).toBeTruthy();
    expect(screen.getByText('unlocksAnalyticsTierAdvanced')).toBeTruthy();
    expect(screen.getByText('availableOn:بيزنس')).toBeTruthy();
    const up = screen.getByText('upgradeCta:بيزنس').closest('a');
    expect(up?.getAttribute('href')).toBe('/stores/store-1/billing?plan=business#plans');
    expect(screen.queryByText('defaultRetry')).toBeNull();
    expect(screen.queryByText('defaultTitle')).toBeNull();
  });

  it('keeps the error + retry for an ordinary failure', () => {
    render(<ErrorState message="Too many requests" onRetry={() => {}} />);
    expect(screen.getByText('Too many requests')).toBeTruthy();
    expect(screen.getByText('defaultRetry')).toBeTruthy();
  });
});

describe('store route error boundary', () => {
  it('keeps the shell and never prints the JS message', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <StoreRouteError
        error={Object.assign(
          new Error("Cannot read properties of undefined (reading 'firstName')"),
          {
            digest: 'abc',
          }
        )}
        reset={() => {}}
      />
    );
    expect(screen.getByTestId('shell')).toBeTruthy();
    expect(document.body.textContent).not.toContain('firstName');
    expect(document.body.textContent).not.toContain('Cannot read');
    expect(screen.getByText('retry')).toBeTruthy();
    spy.mockRestore();
  });

  it('shows the upgrade card when the thrown error is a plan refusal', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <StoreRouteError
        error={Object.assign(new Error('x'), { status: 402, code: 'PLAN_LIMIT_REACHED' })}
        reset={() => {}}
      />
    );
    expect(screen.getByText('lockedBadge')).toBeTruthy();
    expect(screen.queryByText('retry')).toBeNull();
    spy.mockRestore();
  });
});

describe('navFeatureState', () => {
  const on = (k: string) => k === 'on';
  const ctx = { isEnabled: on, isLoading: false, isSuperAdmin: false };
  it('is open without a feature, while loading, for super admins and for enabled features', () => {
    expect(navFeatureState(null, ctx)).toBe('open');
    expect(navFeatureState('email_campaigns', { ...ctx, isLoading: true })).toBe('open');
    expect(navFeatureState('email_campaigns', { ...ctx, isSuperAdmin: true })).toBe('open');
    expect(navFeatureState('on', ctx)).toBe('open');
  });
  it('locks a sold-plan feature that is off and hides one no sold plan includes', () => {
    expect(navFeatureState('email_campaigns', ctx)).toBe('locked');
    expect(navFeatureState('feature_nobody_sells', ctx)).toBe('hidden');
  });
});
