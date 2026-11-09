// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { apiPut } = vi.hoisted(() => ({ apiPut: vi.fn() }));
vi.mock('../../../lib/api', () => ({ apiPut }));
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('@/i18n/useT', () => {
  const useT = (ns?: string) => (key: string, vars?: Record<string, unknown>) =>
    `${ns ? `${ns}.` : ''}${key}${vars ? `:${JSON.stringify(vars)}` : ''}`;
  return { useT };
});

import { PlanStep } from './PlanStep';
import { STATIC_PLANS } from '../../../components/billing/plans';

const stored = new Map<string, string>();
beforeEach(() => {
  stored.clear();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => void stored.set(k, v),
    },
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const plan = (name: RegExp) => screen.getByRole('radio', { name });

describe('PlanStep', () => {
  it('shows the three public plans with the locked EGP prices, monthly then annual', () => {
    expect(STATIC_PLANS.map(p => p.code)).toEqual(['basic', 'growth', 'business']);
    render(
      <PlanStep
        plans={STATIC_PLANS}
        initial={{ planCode: 'growth', interval: 'monthly' }}
        onDone={vi.fn()}
      />
    );
    expect(screen.getByText(/onboarding.flow.plan.trialNote/)).toBeTruthy();
    expect(plan(/Basic/).textContent).toContain('EGP 1,490.00');
    expect(plan(/Growth/).textContent).toContain('EGP 3,490.00');
    expect(plan(/Business/).textContent).toContain('EGP 9,990.00');
    expect(plan(/Growth/).getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: /onboarding\.flow\.plan\.yearly/ }));
    // Annual = 25% off: nine monthly payments for twelve months.
    expect(plan(/Basic/).textContent).toContain('EGP 13,410.00');
    expect(plan(/Basic/).textContent).toContain('onboarding.flow.plan.perYear');
  });

  it('before a store exists: keeps the choice in state + storage, sends no request', async () => {
    const onDone = vi.fn();
    render(
      <PlanStep
        plans={STATIC_PLANS}
        initial={{ planCode: 'growth', interval: 'monthly' }}
        onDone={onDone}
      />
    );
    fireEvent.click(plan(/Business/));
    fireEvent.click(screen.getByRole('button', { name: /onboarding\.flow\.plan\.yearly/ }));
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.next' }));
    await waitFor(() =>
      expect(onDone).toHaveBeenCalledWith({ planCode: 'business', interval: 'yearly' })
    );
    expect(apiPut).not.toHaveBeenCalled();
    expect(JSON.parse(stored.get('ebda.signup.plan')!)).toEqual({
      planCode: 'business',
      interval: 'yearly',
    });
  });

  it('with a store: saves via PUT trial-plan, and shows the error when the trial is over', async () => {
    const onDone = vi.fn();
    apiPut.mockResolvedValueOnce({ data: null, error: { code: 'NOT_TRIALING', status: 409 } });
    render(
      <PlanStep
        plans={STATIC_PLANS}
        initial={{ planCode: 'growth', interval: 'monthly' }}
        storeId="s1"
        onDone={onDone}
      />
    );
    fireEvent.click(plan(/Basic/));
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.next' }));
    expect((await screen.findByRole('alert')).textContent).toBe('onboarding.flow.plan.notTrialing');
    expect(apiPut).toHaveBeenCalledWith('/api/v1/stores/s1/billing/trial-plan', {
      planCode: 'basic',
      interval: 'monthly',
    });
    expect(onDone).not.toHaveBeenCalled();

    apiPut.mockResolvedValueOnce({ data: {}, error: null });
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.next' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });
});
