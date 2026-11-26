// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SETUP_GUIDE_ITEMS, type SetupGuideState } from '@ebda/shared';

vi.mock('next-intl', () => {
  const t = (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${JSON.stringify(values)}` : key;
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('next/link', () => ({
  default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...r}>
      {children}
    </a>
  ),
}));
const params = vi.hoisted(() => ({ id: 'store-1' as string | undefined }));
vi.mock('next/navigation', () => ({ useParams: () => ({ id: params.id }) }));
const apiGet = vi.fn();
vi.mock('../../lib/api', () => ({ apiGet: (...a: unknown[]) => apiGet(...a) }));

import { LaunchReadinessChip } from './LaunchReadinessChip';
import { launchProgress } from './launch-progress';

function guide(over: Partial<SetupGuideState> & { doneKeys?: string[] } = {}): SetupGuideState {
  const { doneKeys = [], ...rest } = over;
  const items = SETUP_GUIDE_ITEMS.map(d => ({
    key: d.key,
    done: doneKeys.includes(d.key),
    fromData: true,
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
    dismissed: false,
    paidOrders: 0,
    ...rest,
  };
}
const allRequired = SETUP_GUIDE_ITEMS.filter(d => !d.optional).map(d => d.key);

describe('launchProgress (same state as the checklist card)', () => {
  it('counts steps with the card numbers while a required step is open', () => {
    const g = guide({ doneKeys: ['add_product', 'brand'] });
    expect(launchProgress(g)).toEqual({ phase: 'steps', done: 2, total: g.totalCount });
  });
  it('switches to paid orders once every required step is done (even if the guide was dismissed)', () => {
    expect(
      launchProgress(guide({ doneKeys: allRequired, paidOrders: 2, dismissed: true }))
    ).toEqual({ phase: 'orders', done: 2, total: 5 });
  });
  it('4 paid -> still shown, 5 paid -> done', () => {
    expect(launchProgress(guide({ doneKeys: allRequired, paidOrders: 4 })).phase).toBe('orders');
    expect(launchProgress(guide({ doneKeys: allRequired, paidOrders: 5 })).phase).toBe('done');
  });
  it('older API without paidOrders counts 0', () => {
    expect(launchProgress(guide({ doneKeys: allRequired, paidOrders: undefined }))).toMatchObject({
      phase: 'orders',
      done: 0,
    });
  });
});

beforeEach(() => {
  apiGet.mockReset();
  params.id = 'store-1';
});
afterEach(cleanup);

describe('<LaunchReadinessChip>', () => {
  it('shows the steps phase, reads the setup-guide endpoint, and has no dismiss control', async () => {
    apiGet.mockResolvedValue({ data: guide({ doneKeys: ['add_product'] }) });
    render(<LaunchReadinessChip />);
    const chip = await screen.findByTestId('launch-chip');
    expect(chip.getAttribute('data-phase')).toBe('steps');
    expect(apiGet).toHaveBeenCalledWith('/api/v1/stores/store-1/setup-guide');
    expect(screen.queryByText(/dismiss|hide/i)).toBeNull();
  });
  it('clicking opens the checklist with a link to each open step; Escape closes it', async () => {
    apiGet.mockResolvedValue({ data: guide({ doneKeys: ['add_product'] }) });
    render(<LaunchReadinessChip />);
    fireEvent.click(await screen.findByRole('button'));
    const dialog = screen.getByRole('dialog');
    expect(dialog.querySelector('[data-key="add_product"]')?.getAttribute('data-done')).toBe(
      'true'
    );
    const hrefs = Array.from(dialog.querySelectorAll('a')).map(a => a.getAttribute('href'));
    expect(hrefs).toContain('/stores/store-1/branding');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('orders phase links to orders', async () => {
    apiGet.mockResolvedValue({ data: guide({ doneKeys: allRequired, paidOrders: 3 }) });
    render(<LaunchReadinessChip />);
    expect((await screen.findByTestId('launch-chip')).getAttribute('data-phase')).toBe('orders');
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('dialog').querySelector('a')?.getAttribute('href')).toBe(
      '/stores/store-1/orders'
    );
  });
  it('disappears at 5 paid orders', async () => {
    apiGet.mockResolvedValue({ data: guide({ doneKeys: allRequired, paidOrders: 5 }) });
    const { container } = render(<LaunchReadinessChip />);
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    await Promise.resolve();
    expect(container.innerHTML).toBe('');
  });
  it('renders nothing without a store in the route or when the request fails', async () => {
    params.id = undefined;
    const a = render(<LaunchReadinessChip />);
    expect(apiGet).not.toHaveBeenCalled();
    expect(a.container.innerHTML).toBe('');
    cleanup();
    params.id = 'store-1';
    apiGet.mockResolvedValue({ data: null, error: 'x' });
    const b = render(<LaunchReadinessChip />);
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(b.container.innerHTML).toBe('');
  });
});
