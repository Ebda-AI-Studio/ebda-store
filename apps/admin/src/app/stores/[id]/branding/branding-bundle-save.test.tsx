// @vitest-environment jsdom
/**
 * Branding Save is ONE request (BE:F-3) carrying only this page's keys (BE:F-2): the bundle route, no GET of the
 * whole settings blob, no `blogEnabled`, and the sticky bar appears only once something changed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const { apiGet, apiPut, toast } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPut: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 's1' }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/stores/s1/branding',
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@ebda/ui', async importOriginal => ({
  ...(await importOriginal<typeof import('@ebda/ui')>()),
  useToast: () => toast,
}));
vi.mock('@/i18n/useT', () => ({ useT: () => (k: string) => k }));
vi.mock('../../../../lib/api', () => ({ apiGet, apiPut }));
vi.mock('../../../../components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../../../components/AdminSkeleton', () => ({ AdminSkeletonDetail: () => null }));
vi.mock('./_components/BrandingTabs', () => ({ BrandingTabs: () => null }));
vi.mock('./_components/ContactInfoTab', () => ({ ContactInfoTab: () => null }));
vi.mock('./_components/SocialLinksTab', () => ({ SocialLinksTab: () => null }));
vi.mock('./_components/ThemeTab', () => ({ ThemeTab: () => null }));
vi.mock('./_components/LocationsTab', () => ({ LocationsTab: () => null }));
vi.mock('./_components/BrandingIdentityTab', () => ({
  BrandingIdentityTab: ({
    branding,
    onChange,
  }: {
    branding: { name: string };
    onChange: (b: unknown) => void;
  }) => <button onClick={() => onChange({ ...branding, name: 'Renamed' })}>rename</button>,
}));

import StoreBrandingPage from './page';

const STORE = {
  id: 's1',
  name: 'Old',
  blogEnabled: false,
  socialLinks: {},
  settings: { footerLinks: ['x'], contact: { addressUrl: 'https://maps', mapPin: 7 } },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('branding page save', () => {
  it('shows no save bar until something changes, then sends exactly one bundle request', async () => {
    apiGet.mockResolvedValue({ data: { store: STORE }, error: null });
    apiPut.mockResolvedValue({ data: {}, error: null });
    render(<StoreBrandingPage />);
    await screen.findByText('rename');
    expect(screen.queryByText('save')).toBeNull();

    fireEvent.click(screen.getByText('rename'));
    fireEvent.click(await screen.findByText('save'));

    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1));
    const [url, body] = apiPut.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('/api/v1/stores/s1/branding-bundle');
    expect((body.branding as { name: string }).name).toBe('Renamed');
    // Only this page's keys: settings carries `contact` alone (extra stored contact keys kept), no blogEnabled.
    expect(Object.keys(body.settings as object)).toEqual(['contact']);
    expect((body.settings as { contact: Record<string, unknown> }).contact.mapPin).toBe(7);
    expect(body).not.toHaveProperty('blogEnabled');
    // Untouched theme is not sent; the whole settings blob is never fetched again for a merge.
    expect(body).not.toHaveProperty('theme');
    expect(apiGet).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it('a failed bundle shows one error and keeps the bar so nothing is lost', async () => {
    apiGet.mockResolvedValue({ data: { store: STORE }, error: null });
    apiPut.mockResolvedValue({ data: null, error: { status: 429, message: 'محاولات كتير' } });
    render(<StoreBrandingPage />);
    fireEvent.click(await screen.findByText('rename'));
    fireEvent.click(await screen.findByText('save'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(screen.getByText('save')).toBeTruthy();
  });
});
