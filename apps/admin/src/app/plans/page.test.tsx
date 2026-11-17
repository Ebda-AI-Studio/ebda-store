// @vitest-environment jsdom
/**
 * Super-admin Plans page (SP5 task 1): "open /plans -> rows render". Null
 * prices read "not set" (never 0) and null limits read "unlimited".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { apiGet, apiPut } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPut: vi.fn() }));
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
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
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Button: (p: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...p} />,
  Input: ({ label, ...p }: { label?: string } & React.InputHTMLAttributes<HTMLInputElement>) => (
    <input aria-label={label} {...p} />
  ),
  Modal: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div role="dialog">{children}</div> : null,
  ModalBody: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ModalFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

import PlansPage from './page';

const base = {
  sort: 1,
  isPublic: true,
  featureTier: 'free',
  priceMonthlyMinor: null,
  priceYearlyMinor: null,
  subscriberCount: 3,
};
const lim = {
  maxStaff: 1,
  maxOrdersPerMonth: 100,
  maxStorageMb: 500,
  customDomain: false,
  platformFeeBps: 150,
  codPlatformFeeBps: 0,
  abandonedCartAutomation: false,
  whatsappAutomation: false,
  maxStores: 1,
  brandingRemoval: false,
  apiAccess: false,
  wholesalePricing: false,
  analyticsTier: 'basic',
  supportTier: 'email',
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('super-admin plans page', () => {
  it('lists plans; unset prices say "not set", null limits say "unlimited"', async () => {
    apiGet.mockResolvedValue({
      data: {
        plans: [
          {
            ...base,
            code: 'free',
            nameEn: 'Free',
            nameAr: 'مجاني',
            limits: { ...lim, maxProducts: 50 },
          },
          {
            ...base,
            code: 'comped',
            nameEn: 'Comped',
            nameAr: 'منحة',
            isPublic: false,
            limits: { ...lim, maxProducts: null, maxStaff: null, maxOrdersPerMonth: null },
          },
        ],
      },
      error: null,
    });
    render(<PlansPage />);

    expect(await screen.findByText('Free')).toBeTruthy();
    expect(screen.getByText('Comped')).toBeTruthy();
    expect(screen.getAllByText('priceNotSet').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('unlimited').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('hidden')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'edit' }).length).toBe(2);
  });

  it('shows the load-failure state on error', async () => {
    apiGet.mockResolvedValue({
      data: null,
      error: { code: 'SERVER_ERROR', message: 'x', status: 500 },
    });
    render(<PlansPage />);
    expect(await screen.findByText('loadError')).toBeTruthy();
  });

  async function openFree(limitsOver: Record<string, unknown> = {}) {
    apiGet.mockResolvedValue({
      data: {
        plans: [
          {
            ...base,
            priceMonthlyMinor: 29900,
            code: 'free',
            nameEn: 'Free',
            nameAr: 'مجاني',
            limits: { ...lim, maxProducts: 50, platformFeeBps: 250, ...limitsOver },
          },
        ],
      },
      error: null,
    });
    render(<PlansPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'edit' }));
    await screen.findByRole('dialog');
  }

  it('shows fees as percent, save is disabled until dirty, sends bps unchanged contract', async () => {
    apiPut.mockResolvedValue({ data: {}, error: null });
    await openFree();
    const fee = screen.getByLabelText('limits.platformFeeBps') as HTMLInputElement;
    expect(fee.value).toBe('2.5');
    const save = screen.getByRole('button', { name: 'save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(fee, { target: { value: '3.25' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(apiPut).toHaveBeenCalled());
    const body = apiPut.mock.calls[0][1];
    expect(apiPut.mock.calls[0][0]).toBe('/api/v1/admin/plans/free');
    expect(body.limits.platformFeeBps).toBe(325);
    expect(body.limits.codPlatformFeeBps).toBe(0);
    expect(body.priceMonthlyMinor).toBe(29900);
    expect(body.priceYearlyMinor).toBeNull();
  });

  it('keeps save disabled for an invalid fee', async () => {
    await openFree();
    const fee = screen.getByLabelText('limits.platformFeeBps');
    fireEvent.change(fee, { target: { value: '100.5' } });
    expect((screen.getByRole('button', { name: 'save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('form.invalidFee')).toBeTruthy();
  });

  it('renders switches with role=switch + aria-checked and toggles them', async () => {
    await openFree();
    const sw = screen.getByRole('switch', { name: 'limits.customDomain' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('switch', { name: 'form.isPublic' }).getAttribute('aria-checked')).toBe(
      'true'
    );
  });

  it('unlimited checkbox disables its number input', async () => {
    await openFree();
    const input = screen.getByLabelText('limits.maxProducts') as HTMLInputElement;
    expect(input.disabled).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name: 'limits.maxProducts: unlimited' }));
    expect(input.disabled).toBe(true);
  });

  it('explains an empty price and shows the EGP unit', async () => {
    await openFree();
    expect(screen.getByText('form.priceYearlyHelp')).toBeTruthy();
    expect(screen.getAllByText('form.currency').length).toBe(2);
  });
});
