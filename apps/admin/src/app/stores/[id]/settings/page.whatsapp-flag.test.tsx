// @vitest-environment jsdom
/**
 * WHATSAPP-OFF-1 (2026-10-14): the WhatsApp Business API integration is flagged
 * OFF for every store. Its Settings card (the only nav entry to /whatsapp and
 * its status fetch against /integrations/wbs) renders ONLY when the `whatsapp`
 * feature resolves ON for the store. The wa.me features live on other pages and
 * do not depend on the flag.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

const state = vi.hoisted(() => ({
  enabled: new Set<string>(),
  isLoading: false,
  apiGet: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'store-1' }) }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('../../../../lib/api', () => ({
  apiGet: state.apiGet,
  apiPatch: vi.fn(),
  apiPut: vi.fn(),
}));
vi.mock('../../../../lib/auth', () => ({ useAuth: () => ({ user: { role: 'store_admin' } }) }));
vi.mock('../../../../hooks/useFeatures', () => ({
  useFeatures: () => ({
    isEnabled: (k: string) => state.enabled.has(k),
    isLoading: state.isLoading,
    refresh: vi.fn(),
  }),
}));
vi.mock('../../../../components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../../../components/SettingsSearch', () => ({ SettingsSearch: () => null }));
vi.mock('@/i18n/useT', () => ({
  useT: (ns: string) => (key: string) => `${ns}.${key}`,
}));
vi.mock('@ebda/ui', () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  Modal: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

import StoreSettingsPage from './page';

const WA_HREF = '/stores/store-1/whatsapp';

beforeEach(() => {
  state.enabled = new Set();
  state.isLoading = false;
  state.apiGet.mockResolvedValue({
    data: { hasApiKey: true, wbsEnabled: true, waCustomerOrderingEnabled: true },
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const hrefs = () => screen.getAllByRole('link').map(a => a.getAttribute('href'));

describe('Settings hub — WhatsApp Business API card', () => {
  it('is hidden (and never fetches WBS status) when the whatsapp feature is OFF', () => {
    render(<StoreSettingsPage />);
    expect(hrefs()).not.toContain(WA_HREF);
    expect(state.apiGet.mock.calls.some(([url]) => String(url).includes('/integrations/wbs'))).toBe(
      false
    );
    // The rest of the hub still renders (always-on cards).
    expect(hrefs()).toContain('/stores/store-1/branding');
  });

  it('is shown when the per-store override turns the whatsapp feature ON', () => {
    state.enabled = new Set(['whatsapp']);
    render(<StoreSettingsPage />);
    expect(hrefs()).toContain(WA_HREF);
    expect(state.apiGet.mock.calls.some(([url]) => String(url).includes('/integrations/wbs'))).toBe(
      true
    );
  });

  it('wa.me contact settings live under Branding, which does not depend on the flag', () => {
    render(<StoreSettingsPage />);
    expect(hrefs()).toContain('/stores/store-1/branding');
  });
});
