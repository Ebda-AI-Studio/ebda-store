// @vitest-environment jsdom
/** Platform settings: Ebda VAT cannot be enabled without TRN + legal name. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { apiGet, apiPut } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPut: vi.fn() }));
const confirmMock = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useConfirm', () => ({ useConfirm: () => confirmMock }));
vi.mock('../../lib/api', () => ({ apiGet, apiPut }));
vi.mock('../../components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../components/RequireSuperAdmin', () => ({
  RequireSuperAdmin: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../i18n/useT', () => {
  const t = (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key;
  return { useT: () => t };
});
vi.mock('@ebda/ui', () => ({
  Button: (p: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...p} />,
  Input: ({ label, ...p }: { label?: string }) => <input aria-label={label} {...p} />,
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

import PlatformSettingsPage from './page';

const off = { enabled: false, rate: 14, mode: 'exclusive', trn: null, legalName: null };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('platform settings — Ebda VAT', () => {
  it('refuses to enable without TRN and legal name (no PUT)', async () => {
    apiGet.mockResolvedValue({ data: { vat: off }, error: null });
    render(<PlatformSettingsPage />);
    await screen.findByText('vat.title');
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getByText('vat.save'));
    expect((await screen.findByRole('alert')).textContent).toBe('vat.requiredToEnable');
    expect(apiPut).not.toHaveBeenCalled();
  });

  it('confirms, then saves all five keys when enabling with TRN + name', async () => {
    apiGet.mockResolvedValue({ data: { vat: off }, error: null });
    apiPut.mockResolvedValue({
      data: { vat: { ...off, enabled: true, trn: '123456789', legalName: 'Ebda AI Studio' } },
      error: null,
    });
    confirmMock.mockResolvedValue(true);
    render(<PlatformSettingsPage />);
    await screen.findByText('vat.title');
    fireEvent.change(screen.getByLabelText('vat.trn'), { target: { value: '123-456-789' } });
    fireEvent.change(screen.getByLabelText('vat.legalName'), {
      target: { value: 'Ebda AI Studio' },
    });
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getByText('vat.save'));
    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/api/v1/admin/platform-vat', {
        enabled: true,
        rate: 14,
        mode: 'exclusive',
        trn: '123456789',
        legalName: 'Ebda AI Studio',
      })
    );
    expect(confirmMock).toHaveBeenCalled();
  });

  it('does not save when the confirm dialog is declined', async () => {
    apiGet.mockResolvedValue({
      data: { vat: { ...off, trn: '123456789', legalName: 'W11' } },
      error: null,
    });
    confirmMock.mockResolvedValue(false);
    render(<PlatformSettingsPage />);
    await screen.findByText('vat.title');
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getByText('vat.save'));
    expect(apiPut).not.toHaveBeenCalled();
  });
});
