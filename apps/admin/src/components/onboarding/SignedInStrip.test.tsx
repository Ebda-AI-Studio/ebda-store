// @vitest-environment jsdom
/**
 * Gate pages (onboarding with no store, accept-invite errors, verify-email...) all render inside PublicShell. A signed-in person
 * there must always have a visible Sign out that calls logout(); a signed-out visitor must not see one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const auth = vi.hoisted(() => ({
  value: { isAuthenticated: true, user: { email: 'ahmad@example.com' }, logout: vi.fn() },
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => auth.value }));
vi.mock('next-intl', () => ({ useLocale: () => 'ar' }));
vi.mock('next/image', () => ({
  default: ({ alt }: { alt: string }) => <span role="img" aria-label={alt} />,
}));
vi.mock('@/i18n/useT', () => ({ useT: (ns?: string) => (key: string) => `${ns}.${key}` }));
vi.mock('../AdminLanguageSwitcher', () => ({ default: () => null }));
vi.mock('../DocumentTitle', () => ({ DocumentTitle: () => null }));
vi.mock('@/lib/use-pinned-light-theme', () => ({ usePinnedLightTheme: () => undefined }));

import { PublicShell } from './PublicShell';

afterEach(() => {
  cleanup();
  auth.value.logout.mockClear();
  auth.value.isAuthenticated = true;
});

describe('PublicShell signed-in strip', () => {
  it('shows the masked account and a real Sign out button that logs out', () => {
    render(
      <PublicShell title="t">
        <p>body</p>
      </PublicShell>
    );
    const strip = screen.getByTestId('signed-in-strip');
    expect(strip.textContent).toContain('a***@example.com');
    expect(strip.textContent).not.toContain('ahmad@');
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.shell.signOut' }));
    expect(auth.value.logout).toHaveBeenCalledTimes(1);
  });
  it('shows nothing to a signed-out visitor', () => {
    auth.value.isAuthenticated = false;
    render(
      <PublicShell title="t">
        <p>body</p>
      </PublicShell>
    );
    expect(screen.queryByTestId('signed-in-strip')).toBeNull();
  });
});
