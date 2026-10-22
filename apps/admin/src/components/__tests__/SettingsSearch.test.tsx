// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const push = vi.fn();
let role = 'store_admin';
let enabled: (k: string) => boolean = () => true;
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  useParams: () => ({ id: 'store-1' }),
}));
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('@/i18n/useT', () => ({ useT: () => (key: string) => key }));
vi.mock('../../lib/auth', () => ({ useAuth: () => ({ user: { role } }) }));
vi.mock('../../hooks/useFeatures', () => ({
  useFeatures: () => ({ isEnabled: (k: string) => enabled(k), isLoading: false }),
}));

import { SettingsSearch } from '../SettingsSearch';

beforeEach(() => {
  push.mockReset();
  role = 'store_admin';
  enabled = () => true;
});
afterEach(cleanup);

const search = (q: string) => {
  render(<SettingsSearch />);
  const input = screen.getByRole('searchbox');
  fireEvent.change(input, { target: { value: q } });
  return input;
};

describe('Settings search box (E23)', () => {
  it('finds ANY admin page, not only the cards on the settings page', () => {
    search('purchase orders');
    expect(screen.getByRole('option', { name: /Purchase Orders/ })).toBeTruthy();
  });

  it('finds an individual setting by an Arabic query and opens it at the control', () => {
    const input = search('ايام بدون توصيل');
    const option = screen.getAllByRole('option')[0];
    expect(option.textContent).toContain('Days with no delivery');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(push).toHaveBeenCalledWith('/stores/store-1/delivery?setting=delivery.off-days');
  });

  it('staff do not see owner-only settings', () => {
    // the owner finds the Branding logo settings by "logo" (so the assertion below can fail)
    search('logo');
    expect(
      screen.queryAllByRole('option', { name: /Logo size|Footer logo/ }).length
    ).toBeGreaterThan(0);
    cleanup();
    role = 'staff';
    search('logo');
    // staff still find the editor's own logo position (a staff control), never the owner-only ones
    expect(screen.queryAllByRole('option', { name: /Logo size|Footer logo/ })).toHaveLength(0);
    expect(screen.queryAllByRole('option', { name: /Logo position/ }).length).toBeGreaterThan(0);
  });

  it('a feature the store lacks is not offered', () => {
    enabled = k => k !== 'pwa';
    search('app name');
    expect(screen.queryByRole('option', { name: /App Name/ })).toBeNull();
  });
});
