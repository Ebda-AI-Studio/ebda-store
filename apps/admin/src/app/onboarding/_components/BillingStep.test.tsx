// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('../../../lib/api', () => ({ apiGet, apiPost }));
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('@/i18n/useT', () => {
  const useT = (ns?: string) => (key: string, vars?: Record<string, unknown>) =>
    `${ns ? `${ns}.` : ''}${key}${vars ? `:${JSON.stringify(vars)}` : ''}`;
  return { useT };
});

import { BillingStep } from './BillingStep';
import { STATIC_PLANS } from '../../../components/billing/plans';
import { billingFixture } from '../../../components/billing/fixtures';
import type { BillingInfo } from '../../../components/billing/types';

function setup(billing: BillingInfo | null) {
  const onBillingChange = vi.fn();
  const onDone = vi.fn();
  render(
    <BillingStep
      storeId="s1"
      billing={billing}
      plans={STATIC_PLANS}
      onBillingChange={onBillingChange}
      onBack={vi.fn()}
      onDone={onDone}
    />
  );
  return { onBillingChange, onDone };
}
const next = () =>
  screen.getByRole('button', { name: 'onboarding.flow.next' }) as HTMLButtonElement;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('BillingStep', () => {
  it('card option: says nothing is charged now, redirects to the hosted page, Continue stays locked', async () => {
    apiPost.mockResolvedValue({ data: { redirectUrl: 'https://pay.test/card/1' }, error: null });
    const loc = { href: '', search: '' };
    vi.stubGlobal('location', loc);
    setup(billingFixture());
    expect(
      screen.getByText(
        (c, el) =>
          el?.tagName === 'P' &&
          c.startsWith('onboarding.flow.billing.cardBody:') &&
          c.includes('"amount":"EGP 3,490.00"') &&
          c.includes('"plan":"Growth"')
      )
    ).toBeTruthy();
    expect(next().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.billing.cardCta' }));
    await waitFor(() => expect(loc.href).toBe('https://pay.test/card/1'));
    expect(apiPost).toHaveBeenCalledWith('/api/v1/stores/s1/billing/card-setup', {
      from: 'onboarding',
    });
  });

  it('offers the card only when the trial mode is card_on_file', () => {
    setup(
      billingFixture({
        trialCardMode: 'pay_at_trial_end',
        instapay: {
          available: true,
          handle: 'ebda@instapay',
          reference: null,
          amountMinor: null,
          pendingClaims: 0,
        },
      })
    );
    expect(screen.queryByRole('button', { name: 'onboarding.flow.billing.cardCta' })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'onboarding.flow.billing.instapayCta' })
    ).toBeTruthy();
  });

  it('hides the card option when the provider cannot set one up', async () => {
    apiPost.mockResolvedValue({
      data: null,
      error: { code: 'CARD_SETUP_UNAVAILABLE', status: 409 },
    });
    setup(billingFixture());
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.billing.cardCta' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'onboarding.flow.billing.cardCta' })).toBeNull()
    );
  });

  it('InstaPay: records the choice, shows handle + exact amount + reference, then unlocks Continue', async () => {
    const chosen = billingFixture({
      trialCardMode: 'pay_at_trial_end',
      billingMethod: 'instapay',
      instapay: {
        available: true,
        handle: 'ebda@instapay',
        reference: 'EBD-7K2Q',
        amountMinor: 349000,
        pendingClaims: 0,
      },
    });
    apiPost.mockResolvedValue({
      data: { billingMethod: 'instapay', paymentReference: 'EBD-7K2Q' },
      error: null,
    });
    apiGet.mockResolvedValue({ data: { billing: chosen }, error: null });
    const { onBillingChange } = setup(
      billingFixture({
        trialCardMode: 'pay_at_trial_end',
        instapay: { ...chosen.instapay, handle: null, reference: null, amountMinor: null },
      })
    );
    expect(next().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.billing.instapayCta' }));
    await waitFor(() => expect(onBillingChange).toHaveBeenCalledWith(chosen));
    expect(apiPost).toHaveBeenCalledWith('/api/v1/stores/s1/billing/payment-method', {
      method: 'instapay',
    });
  });

  it('InstaPay chosen: shows the transfer details and the "transfer before" instruction', () => {
    const { onDone } = setup(
      billingFixture({
        trialCardMode: 'pay_at_trial_end',
        billingMethod: 'instapay',
        instapay: {
          available: true,
          handle: 'ebda@instapay',
          reference: 'EBD-7K2Q',
          amountMinor: 349000,
          pendingClaims: 0,
        },
      })
    );
    expect(screen.getByText('ebda@instapay')).toBeTruthy();
    expect(screen.getByText('EGP 3,490.00')).toBeTruthy();
    expect(screen.getByText('EBD-7K2Q')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /billing\.instapay\.copy/ })).toHaveLength(3);
    // No QR configured -> no image at all (never a broken one); no VAT line while VAT is OFF.
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByTestId('instapay-vat')).toBeNull();
    expect(screen.getByText(/instapayHow:\{"date":"20 November 2026"\}/)).toBeTruthy();
    expect(next().disabled).toBe(false);
    fireEvent.click(next());
    expect(onDone).toHaveBeenCalled();
  });

  it('InstaPay QR + phone steps + VAT line when configured; a QR that fails to load is hidden', () => {
    setup(
      billingFixture({
        trialCardMode: 'pay_at_trial_end',
        billingMethod: 'instapay',
        instapay: {
          available: true,
          handle: 'voidengineer911@instapay',
          reference: 'EBD-7K2Q',
          amountMinor: 397860,
          qrUrl: 'https://media.ebda.app/platform/instapay-qr.jpg',
          vat: {
            netMinor: 349000,
            vatMinor: 48860,
            rateBps: 1400,
            mode: 'exclusive',
            trn: '123456789',
            legalName: 'Ebda AI Studio',
          },
          pendingClaims: 0,
        },
      })
    );
    const img = screen.getByRole('img', { name: 'billing.instapay.qrAlt' }) as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('https://media.ebda.app/platform/instapay-qr.jpg');
    expect(screen.getByRole('list', { name: 'billing.instapay.phoneTitle' })).toBeTruthy();
    expect(screen.getByText('EGP 3,978.60')).toBeTruthy();
    const vat = screen.getByTestId('instapay-vat').textContent ?? '';
    expect(vat).toContain('"rate":14');
    expect(vat).toContain('"vat":"EGP 488.60"');
    expect(vat).toContain('"trn":"123456789"');
    fireEvent.error(img);
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('with no way to pay it says so clearly and still lets the merchant continue', () => {
    const { onDone } = setup(billingFixture({ trialCardMode: 'pay_at_trial_end' }));
    expect(screen.getByText('onboarding.flow.billing.noOption')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.billing.continueAnyway' }));
    expect(onDone).toHaveBeenCalled();
  });

  it('shows the saved card and unlocks Continue', () => {
    setup(
      billingFixture({
        hasPaymentMethod: true,
        billingMethod: 'card',
        card: { last4: '4242', brand: 'visa', savedAt: '2026-11-05T00:00:00.000Z' },
      })
    );
    expect(screen.getByText('•••• 4242 visa')).toBeTruthy();
    expect(next().disabled).toBe(false);
  });

  it('back from the hosted page: polls the state until the webhook has saved the card', async () => {
    window.history.replaceState(null, '', '/onboarding?card=return');
    const saved = billingFixture({
      hasPaymentMethod: true,
      billingMethod: 'card',
      card: { last4: '4242', brand: 'visa', savedAt: '2026-11-05T00:00:00.000Z' },
    });
    apiGet.mockResolvedValue({ data: { billing: saved }, error: null });
    const { onBillingChange } = setup(billingFixture());
    await waitFor(() => expect(onBillingChange).toHaveBeenCalledWith(saved));
    expect(await screen.findByText('onboarding.flow.billing.returnOk')).toBeTruthy();
    expect(apiGet).toHaveBeenCalledWith('/api/v1/onboarding/state');
  });

  it('stub provider: the return URL alone is NOT success; simulating confirms through the API', async () => {
    window.history.replaceState(
      null,
      '',
      '/onboarding?card=return&stub=1&merchantOrderId=11111111-1111-1111-1111-111111111111'
    );
    const saved = billingFixture({ hasPaymentMethod: true, billingMethod: 'card' });
    apiGet.mockResolvedValue({ data: { billing: saved }, error: null });
    apiPost.mockResolvedValue({ data: {}, error: null });
    setup(billingFixture());
    const simulate = await screen.findByRole('button', {
      name: 'onboarding.flow.billing.stubSaved',
    });
    expect(apiGet).not.toHaveBeenCalled();
    expect(screen.queryByText('onboarding.flow.billing.returnOk')).toBeNull();
    fireEvent.click(simulate);
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/v1/stores/s1/billing/checkout/stub-confirm', {
        merchantOrderId: '11111111-1111-1111-1111-111111111111',
        outcome: 'success',
      })
    );
    expect(await screen.findByText('onboarding.flow.billing.returnOk')).toBeTruthy();
  });
});
