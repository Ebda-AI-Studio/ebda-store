// @vitest-environment jsdom
/**
 * WHATSAPP-OFF-1: a direct visit to /stores/:id/whatsapp (or one of the legacy
 * pages that redirect there) with the `whatsapp` feature OFF shows the house
 * "feature not enabled" card (FeatureUpgradeGate) — never the tab strip, never a
 * crash, and none of the tabs mount (so no /integrations/wbs call is made).
 * A super-admin still passes through, and the per-store override shows the page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

const state = vi.hoisted(() => ({
  enabled: false,
  role: 'store_admin',
  tabs: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'store-1' }),
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => (key: string) => key,
}));
vi.mock('@/i18n/useT', () => ({ useT: () => (key: string) => key }));
vi.mock('../../../../lib/auth', () => ({ useAuth: () => ({ user: { role: state.role } }) }));
vi.mock('../../../../hooks/useFeatures', () => ({
  useFeatures: () => ({ isEnabled: () => state.enabled, isLoading: false, refresh: vi.fn() }),
}));
vi.mock('../../../../components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@force/ui', () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));
vi.mock('../../../../components/whatsapp/ConnectionTab', () => ({
  ConnectionTab: () => {
    state.tabs('connection');
    return <div data-testid="connection-tab" />;
  },
}));
for (const name of [
  'BotConfigTab',
  'TemplatesTab',
  'OrderUpdatesTab',
  'PaymentLinkTab',
  'BotCopyTab',
  'BotAnalyticsTab',
]) {
  vi.doMock(`../../../../components/whatsapp/${name}`, () => ({ [name]: () => null }));
}

import WhatsAppMasterPage from './page';

beforeEach(() => {
  state.enabled = false;
  state.role = 'store_admin';
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('/stores/:id/whatsapp with the whatsapp feature OFF', () => {
  it('shows the feature-not-enabled card instead of the tabs', () => {
    render(<WhatsAppMasterPage />);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByTestId('connection-tab')).toBeNull();
    expect(state.tabs).not.toHaveBeenCalled();
    // FeatureUpgradeGate: headline is the registry feature name.
    expect(screen.getByRole('heading', { name: 'WhatsApp Notifications' })).toBeTruthy();
  });

  it('renders the page for a store with the per-store override ON', () => {
    state.enabled = true;
    render(<WhatsAppMasterPage />);
    expect(screen.getByRole('tablist')).toBeTruthy();
    expect(screen.getByTestId('connection-tab')).toBeTruthy();
  });

  it('super-admin passes through (house behaviour: they configure features)', () => {
    state.role = 'super_admin';
    render(<WhatsAppMasterPage />);
    expect(screen.getByRole('tablist')).toBeTruthy();
  });
});
