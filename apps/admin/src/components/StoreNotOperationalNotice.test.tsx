// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { apiGetQuiet } = vi.hoisted(() => ({ apiGetQuiet: vi.fn() }));
vi.mock('../i18n/useT', () => ({ useT: () => (key: string) => key }));
vi.mock('../lib/api', async () => ({
  ...(await vi.importActual<typeof import('../lib/api')>('../lib/api')),
  apiGetQuiet,
}));

import { StoreNotOperationalNotice } from './StoreNotOperationalNotice';
import { STORE_NOT_OPERATIONAL_EVENT } from '../lib/api';

afterEach(() => {
  cleanup();
  window.history.pushState({}, '', '/');
  apiGetQuiet.mockReset();
});

describe('StoreNotOperationalNotice', () => {
  it('stays hidden, then shows the suspension message with an appeal link on the 423 event, and closes', () => {
    render(<StoreNotOperationalNotice />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    act(() => {
      window.dispatchEvent(new CustomEvent(STORE_NOT_OPERATIONAL_EVENT));
    });
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(screen.getByText('storeNotOperational')).toBeTruthy();
    const appeal = screen.getByText('storeNotOperationalAppeal') as HTMLAnchorElement;
    expect(appeal.getAttribute('href')).toMatch(/^mailto:.+\?subject=/);
    fireEvent.click(screen.getByText('close'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('G20: a policy suspension links to the appeal form on the store page, not a dead end', async () => {
    window.history.pushState({}, '', '/stores/s1/products');
    apiGetQuiet.mockResolvedValue({ data: { kind: 'policy' }, error: null });
    render(<StoreNotOperationalNotice />);
    act(() => {
      window.dispatchEvent(new CustomEvent(STORE_NOT_OPERATIONAL_EVENT));
    });
    const link = (await screen.findByText('storeNotOperationalAppealForm')) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/stores/s1#suspension-notice');
    expect(apiGetQuiet).toHaveBeenCalledWith('/api/v1/stores/s1/suspension');
  });

  it('G20: a billing suspension says to pay the invoice and links to the billing page', async () => {
    window.history.pushState({}, '', '/stores/s1/campaigns');
    apiGetQuiet.mockResolvedValue({ data: { kind: 'billing' }, error: null });
    render(<StoreNotOperationalNotice />);
    act(() => {
      window.dispatchEvent(new CustomEvent(STORE_NOT_OPERATIONAL_EVENT));
    });
    const link = (await screen.findByText('storeNotOperationalPay')) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/stores/s1/billing');
    await waitFor(() => expect(screen.getByText('storeNotOperationalBilling')).toBeTruthy());
    expect(screen.queryByText('storeNotOperationalAppeal')).toBeNull();
  });
});
