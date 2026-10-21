// @vitest-environment jsdom
/**
 * B2B Task 7: the tier editor. An above-price tier is refused on the client too (the server stays the authority and its verdict
 * is shown if it differs), warnings never block, existing tiers stay deletable without the plan, and the upgrade prompt shows
 * instead of silently hiding the fields.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => {
  const t = Object.assign(
    (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
    { has: () => true }
  );
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
const feat = vi.hoisted(() => ({ on: true }));
vi.mock('../../../../../../../hooks/useFeatures', () => ({
  useFeatures: () => ({ isEnabled: () => feat.on, isLoading: false, refresh: async () => {} }),
}));
const apiGet = vi.fn();
const apiPost = vi.fn();
const apiPut = vi.fn();
const apiDelete = vi.fn();
vi.mock('../../../../../../../lib/api', () => ({
  apiGet: (...a: unknown[]) => apiGet(...a),
  apiPost: (...a: unknown[]) => apiPost(...a),
  apiPut: (...a: unknown[]) => apiPut(...a),
  apiDelete: (...a: unknown[]) => apiDelete(...a),
}));

import { WholesalePricingCard } from './WholesalePricingCard';

const TIER = {
  id: 't1',
  variantId: null,
  groupId: null,
  minQty: 10,
  priceMinor: 8_000,
  stale: false,
};
function mockApi(tiers = [TIER]) {
  apiGet.mockImplementation(async (url: string) => {
    if (url.endsWith('/price-tiers')) return { data: { tiers }, error: null };
    if (url.endsWith('/customer-groups'))
      return { data: { groups: [{ id: 'g1', name: 'Wholesale', nameAr: null }] }, error: null };
    return { data: { variants: [] }, error: null };
  });
}
const renderCard = (o = {}) =>
  render(
    <WholesalePricingCard
      storeId="s1"
      productId="p1"
      priceMinor={10_000}
      costPriceMinor={6_000}
      moq={null}
      audience="public"
      vatBasis="exclusive"
      {...o}
    />
  );
const fill = (qty: string, price: string) => {
  fireEvent.change(screen.getByLabelText('minQty', { selector: 'input' }), {
    target: { value: qty },
  });
  fireEvent.change(screen.getByLabelText('unitPrice', { selector: 'input' }), {
    target: { value: price },
  });
};

beforeEach(() => {
  [apiGet, apiPost, apiPut, apiDelete].forEach(m => m.mockReset());
  feat.on = true;
});
afterEach(cleanup);

describe('WholesalePricingCard', () => {
  it('lists existing tiers with the VAT basis note, and offers the add form', async () => {
    mockApi();
    renderCard();
    expect(await screen.findByText('10+')).toBeTruthy();
    expect(screen.getByText('80.00')).toBeTruthy();
    expect(screen.getByText(/vatExclusive/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'add' })).toBeTruthy();
  });

  it('refuses an above-price tier on the client (the add button stays disabled, nothing is sent)', async () => {
    mockApi();
    renderCard();
    await screen.findByText('10+');
    fill('20', '120');
    expect(screen.getByText('problem.TIER_ABOVE_BASE')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'add' }) as HTMLButtonElement).disabled).toBe(true);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('a valid break shows the margin on cost, posts integer piastres, and reloads', async () => {
    mockApi();
    apiPost.mockResolvedValue({ data: { warnings: [] }, error: null });
    renderCard();
    await screen.findByText('10+');
    fill('50', '70');
    expect(screen.getByText(/margin .*"percent":14/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'add' }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/v1/stores/s1/products/p1/price-tiers', {
        variantId: null,
        groupId: null,
        minQty: 50,
        priceMinor: 7_000,
      })
    );
  });

  it("shows the SERVER's verdict when it disagrees with the client", async () => {
    mockApi();
    apiPost.mockResolvedValue({ data: null, error: { code: 'TIER_DUPLICATE', message: 'dup' } });
    renderCard();
    await screen.findByText('10+');
    fill('50', '70');
    fireEvent.click(screen.getByRole('button', { name: 'add' }));
    expect((await screen.findByRole('alert')).textContent).toBe('problem.TIER_DUPLICATE');
  });

  it('without the plan: the upgrade prompt shows, the add form is gone, existing tiers can still be removed', async () => {
    feat.on = false;
    mockApi();
    apiDelete.mockResolvedValue({ data: {}, error: null });
    renderCard();
    expect((await screen.findByRole('note')).textContent).toContain('upgrade');
    expect(screen.queryByRole('button', { name: 'add' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'remove' }));
    await waitFor(() =>
      expect(apiDelete).toHaveBeenCalledWith('/api/v1/stores/s1/products/p1/price-tiers/t1')
    );
  });

  it('saves the MOQ and the audience through the product update, and rejects a MOQ under 2 before sending', async () => {
    mockApi();
    apiPut.mockResolvedValue({ data: {}, error: null });
    renderCard();
    await screen.findByText('10+');
    fireEvent.change(screen.getByLabelText(/^moq/, { selector: 'input' }), {
      target: { value: '1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'saveRules' }));
    expect((await screen.findByRole('alert')).textContent).toBe('problem.moq');
    expect(apiPut).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/^moq/, { selector: 'input' }), {
      target: { value: '12' },
    });
    fireEvent.change(screen.getByLabelText(/^audienceField/, { selector: 'select' }), {
      target: { value: 'wholesale_only' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'saveRules' }));
    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/api/v1/stores/s1/products/p1', {
        moq: 12,
        audience: 'wholesale_only',
      })
    );
  });
});
