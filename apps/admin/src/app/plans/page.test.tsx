// @vitest-environment jsdom
/**
 * Super-admin Plans page (SP5 task 1): "open /plans -> rows render". Null
 * prices read "not set" (never 0) and null limits read "unlimited".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('../../lib/api', () => ({ apiGet, apiPut: vi.fn() }));
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
vi.mock('@force/ui', () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Button: (p: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...p} />,
  Input: ({ label, ...p }: { label?: string }) => <input aria-label={label} {...p} />,
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
});
