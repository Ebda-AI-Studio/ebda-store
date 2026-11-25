// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ apiGet: vi.fn(), apiPut: vi.fn() }));
vi.mock('../../../lib/api', () => api);
vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'ar' };
});

import { AiSwitchCard } from '../AiSwitchCard';

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('AiSwitchCard', () => {
  it('reads the switch, names it for screen readers, and turns it off with one PUT', async () => {
    api.apiGet.mockResolvedValue({ data: { enabled: true } });
    api.apiPut.mockResolvedValue({ data: { enabled: false } });
    render(<AiSwitchCard storeId="s1" />);
    const sw = await screen.findByRole('switch', { name: 'title' });
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'));
    expect(api.apiGet).toHaveBeenCalledWith('/api/v1/stores/s1/ai/settings');
    fireEvent.click(sw);
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('false'));
    expect(api.apiPut).toHaveBeenCalledWith('/api/v1/stores/s1/ai/settings', { enabled: false });
    expect(screen.getByText('offHint')).toBeTruthy();
  });

  it("shows today's remaining AI requests with the way to buy more", async () => {
    api.apiGet.mockImplementation(async (url: string) =>
      url.endsWith('/billing/addons')
        ? { data: { ai: { used: 100, cap: 450, remaining: 350 } } }
        : { data: { enabled: true } }
    );
    render(<AiSwitchCard storeId="s1" />);
    const line = await screen.findByTestId('ai-quota');
    expect(line.querySelector('a')?.getAttribute('href')).toBe('/stores/s1/billing/addons#ai');
  });

  it('shows an error and keeps the old state when the save fails', async () => {
    api.apiGet.mockResolvedValue({ data: { enabled: true } });
    api.apiPut.mockResolvedValue({ error: { message: 'x' } });
    render(<AiSwitchCard storeId="s1" />);
    const sw = await screen.findByRole('switch');
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'));
    fireEvent.click(sw);
    await screen.findByRole('alert');
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });

  it('is disabled until the current value is known', () => {
    api.apiGet.mockReturnValue(new Promise(() => {}));
    render(<AiSwitchCard storeId="s1" />);
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true);
  });
});
