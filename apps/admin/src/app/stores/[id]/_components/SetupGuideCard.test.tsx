// @vitest-environment jsdom
/**
 * Dashboard setup-guide checklist (SP5 task 2): "open the dashboard -> rows
 * render". The API owns `done` (derived from real store data); the UI must
 * render it faithfully, only offer manual ticks on items that allow them, and
 * persist hide/show through the API rather than the browser.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SETUP_GUIDE_ITEMS, type SetupGuideState } from '@ebda/shared';

const { apiGet, apiPut } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPut: vi.fn() }));
vi.mock('../../../../lib/api', () => ({ apiGet, apiPut }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/i18n/useT', () => {
  const useT = (ns?: string) => (key: string, vars?: Record<string, unknown>) =>
    `${ns ? `${ns}.` : ''}${key}${vars ? `:${JSON.stringify(vars)}` : ''}`;
  return { useT };
});

import { SetupGuideCard } from './SetupGuideCard';

function guide(done: string[], dismissed = false): SetupGuideState {
  const items = SETUP_GUIDE_ITEMS.map(d => ({
    key: d.key,
    done: done.includes(d.key),
    fromData: d.auto && done.includes(d.key) && d.key !== 'payment',
    optional: d.optional,
    manual: d.manual,
  }));
  const required = items.filter(i => !i.optional);
  return {
    items,
    doneCount: items.filter(i => i.done).length,
    totalCount: items.length,
    requiredDone: required.filter(i => i.done).length,
    requiredTotal: required.length,
    dismissed,
  };
}

const row = (key: string) => document.querySelector(`li[data-key="${key}"]`) as HTMLElement;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('setup guide checklist', () => {
  it('renders every item with its API-derived state and a progress count', async () => {
    apiGet.mockResolvedValue({ data: guide(['add_product', 'shipping']), error: null });
    render(<SetupGuideCard storeId="s1" storeUrl="https://shop.ebda.app" />);
    await screen.findByText('onboarding.setupGuide.items.add_product.title');
    expect(apiGet).toHaveBeenCalledWith('/api/v1/stores/s1/setup-guide');
    expect(document.querySelectorAll('li[data-key]')).toHaveLength(7);
    expect(row('add_product').dataset.done).toBe('true');
    expect(row('shipping').dataset.done).toBe('true');
    expect(row('brand').dataset.done).toBe('false');
    expect(screen.getByText('onboarding.setupGuide.progress:{"done":2,"total":7}')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('2');
    // The optional domain row says so.
    expect(row('domain').textContent).toContain('onboarding.setupGuide.optional');
  });

  it('links pending items to their admin page, with no link once done', async () => {
    apiGet.mockResolvedValue({ data: guide(['add_product']), error: null });
    render(<SetupGuideCard storeId="s1" storeUrl="https://shop.ebda.app" />);
    await screen.findByText('onboarding.setupGuide.items.brand.title');
    expect(row('brand').querySelector('a')?.getAttribute('href')).toBe('/stores/s1/branding');
    expect(row('shipping').querySelector('a')?.getAttribute('href')).toBe('/stores/s1/shipping');
    expect(row('add_product').querySelector('a')).toBeNull();
    // Test order opens the storefront itself.
    expect(row('test_order').querySelector('a')?.getAttribute('href')).toBe(
      'https://shop.ebda.app'
    );
  });

  it('offers manual ticks only where the API allows them (never on data-derived items)', async () => {
    apiGet.mockResolvedValue({ data: guide(['add_product']), error: null });
    render(<SetupGuideCard storeId="s1" storeUrl="https://shop.ebda.app" />);
    await screen.findByText('onboarding.setupGuide.items.brand.title');
    const mark = 'onboarding.setupGuide.markDone';
    expect(row('add_product').textContent).not.toContain(mark);
    expect(row('brand').textContent).not.toContain(mark);
    expect(row('shipping').textContent).not.toContain(mark);
    expect(row('payment').textContent).toContain(mark);
    expect(row('domain').textContent).toContain(mark);
  });

  it('ticks a manual item through the API and re-renders from the answer', async () => {
    apiGet.mockResolvedValue({ data: guide([]), error: null });
    apiPut.mockResolvedValue({ data: guide(['payment']), error: null });
    render(<SetupGuideCard storeId="s1" storeUrl="https://shop.ebda.app" />);
    await screen.findByText('onboarding.setupGuide.items.payment.title');
    fireEvent.click(within(row('payment')).getByText('onboarding.setupGuide.markDone'));
    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/api/v1/stores/s1/setup-guide/items/payment', {
        done: true,
      })
    );
    await waitFor(() => expect(row('payment').dataset.done).toBe('true'));
  });

  it('opening the WhatsApp share marks "share" done and builds a wa.me link', async () => {
    apiGet.mockResolvedValue({ data: guide([]), error: null });
    apiPut.mockResolvedValue({ data: guide(['share']), error: null });
    render(<SetupGuideCard storeId="s1" storeUrl="https://shop.ebda.app" />);
    await screen.findByText('onboarding.setupGuide.items.share.title');
    const link = row('share').querySelector('a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toContain('https://wa.me/?text=');
    expect(link.getAttribute('href')).toContain(encodeURIComponent('https://shop.ebda.app'));
    fireEvent.click(link);
    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/api/v1/stores/s1/setup-guide/items/share', {
        done: true,
      })
    );
  });

  it('hides via the API (persisted) and can be shown again', async () => {
    apiGet.mockResolvedValue({ data: guide([]), error: null });
    apiPut.mockResolvedValueOnce({ data: guide([], true), error: null });
    apiPut.mockResolvedValueOnce({ data: guide([], false), error: null });
    render(<SetupGuideCard storeId="s1" storeUrl="https://shop.ebda.app" />);
    fireEvent.click(await screen.findByText('onboarding.setupGuide.dismiss'));
    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/api/v1/stores/s1/setup-guide/dismissed', {
        dismissed: true,
      })
    );
    fireEvent.click(await screen.findByText('onboarding.setupGuide.show'));
    await waitFor(() =>
      expect(apiPut).toHaveBeenLastCalledWith('/api/v1/stores/s1/setup-guide/dismissed', {
        dismissed: false,
      })
    );
    await screen.findByText('onboarding.setupGuide.title');
  });

  it('renders nothing once every required item is done, and an error line on failure', async () => {
    apiGet.mockResolvedValueOnce({
      data: guide(['add_product', 'brand', 'shipping', 'payment', 'test_order', 'share']),
      error: null,
    });
    const { container, unmount } = render(
      <SetupGuideCard storeId="s1" storeUrl="https://shop.ebda.app" />
    );
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    await new Promise(r => setTimeout(r, 20));
    expect(container.textContent).toBe('');
    unmount();

    apiGet.mockResolvedValueOnce({ data: null, error: { code: 'X', message: 'x', status: 500 } });
    render(<SetupGuideCard storeId="s1" storeUrl="https://shop.ebda.app" />);
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});
