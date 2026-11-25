// @vitest-environment jsdom
/** Sidebar badge shows the action count, section badges + the Settings list render from the shared feed. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('next-intl', () => {
  const t = Object.assign(
    (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
    { has: () => true }
  );
  return { useTranslations: () => t, useLocale: () => 'ar' };
});
vi.mock('next/link', () => ({
  default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...r}>
      {children}
    </a>
  ),
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 's1' }),
  usePathname: () => '/stores/s1/settings',
}));
vi.mock('../../hooks/useFeatures', () => ({
  useFeatures: () => ({ isEnabled: () => true, isLoading: false }),
}));
const feed = vi.hoisted(() => ({
  value: {
    items: [] as unknown[],
    loaded: true,
    actionCount: 0,
    bySection: {} as Record<string, number>,
    hasInfoBySection: {} as Record<string, boolean>,
  },
}));
vi.mock('../../hooks/useAttention', () => ({ useAttention: () => feed.value }));

import { SidebarNav } from '../admin-layout/SidebarNav';
import { SettingsRail } from '../admin-layout/SettingsRail';
import { NeedsAttentionList } from './NeedsAttentionList';

afterEach(() => {
  cleanup();
  feed.value = { items: [], loaded: true, actionCount: 0, bySection: {}, hasInfoBySection: {} };
});

const nav = [
  { name: 'Orders', href: '/stores/s1/orders', icon: 'M0 0', hubKey: 'sales' },
  { name: 'Settings', href: '/stores/s1/settings', icon: 'M0 0', hubKey: 'settings' },
];

describe('needs-attention UI', () => {
  it('sidebar: Settings shows the action count; Orders shows none', () => {
    render(
      <SidebarNav navItems={nav} pathname="/" onNavigate={() => {}} badges={{ settings: 3 }} />
    );
    const badges = screen.getAllByTestId('attention-badge');
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toBe('3');
    expect(badges[0].closest('a')?.getAttribute('href')).toBe('/stores/s1/settings');
  });
  it('sidebar: no badge when nothing needs action', () => {
    render(
      <SidebarNav navItems={nav} pathname="/" onNavigate={() => {}} badges={{ settings: 0 }} />
    );
    expect(screen.queryByTestId('attention-badge')).toBeNull();
  });
  it('settings rail: badge only on the affected section', () => {
    feed.value.bySection = { 'payment-settings': 2 };
    render(<SettingsRail storeId="s1" />);
    const badges = screen.getAllByTestId('attention-badge');
    expect(badges).toHaveLength(1);
    expect(badges[0].closest('a')?.getAttribute('href')).toBe('/stores/s1/payment-settings');
  });
  it('overview list: action items link to the exact section, info items are separate', () => {
    feed.value.items = [
      {
        id: 'domain_unverified',
        severity: 'action',
        section: 'domain',
        title: { en: 'Domain', ar: 'الدومين لسه مش متوصّل' },
        message: { en: 'm', ar: 'رسالة' },
      },
      {
        id: 'staff_invites_pending',
        severity: 'info',
        section: 'staff',
        title: { en: 'Invites', ar: 'دعوات' },
        message: { en: 'm', ar: 'رسالة' },
      },
    ];
    render(<NeedsAttentionList storeId="s1" />);
    expect(screen.getByText('الدومين لسه مش متوصّل')).toBeTruthy();
    const fix = screen.getByTestId('attention-item-domain_unverified').querySelector('a');
    expect(fix?.getAttribute('href')).toBe('/stores/s1/domain');
    expect(
      screen
        .getByTestId('attention-item-staff_invites_pending')
        .querySelector('a')
        ?.getAttribute('href')
    ).toBe('/stores/s1/staff');
  });
  it('overview list renders nothing when the store is clean', () => {
    render(<NeedsAttentionList storeId="s1" />);
    expect(screen.queryByTestId('needs-attention-list')).toBeNull();
  });
});
