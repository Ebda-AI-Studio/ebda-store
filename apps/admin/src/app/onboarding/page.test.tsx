// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const auth = vi.hoisted(() => ({
  value: {
    user: { role: 'super_admin', email: 'a@b.test' } as { role: string; email: string },
    logout: vi.fn(),
    isAuthenticated: true,
  },
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => auth.value }));
vi.mock('@/i18n/useT', () => ({ useT: (ns?: string) => (k: string) => `${ns}.${k}` }));
vi.mock('../../components/onboarding/PublicShell', () => ({
  PublicShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('./_components/OnboardingFlow', () => ({
  OnboardingFlow: () => <div data-testid="wizard" />,
}));

import OnboardingPage from './page';

afterEach(() => {
  cleanup();
  auth.value.logout.mockClear();
});

describe('/onboarding for a platform admin', () => {
  it('shows the two-step sign-in prompt, never the store wizard, and both buttons log out', () => {
    render(<OnboardingPage />);
    expect(screen.queryByTestId('wizard')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.platformAdmin.signInAgain' }));
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.platformAdmin.signOut' }));
    expect(auth.value.logout).toHaveBeenCalledTimes(2);
  });
  it('a merchant still gets the wizard', () => {
    auth.value.user = { role: 'store_admin', email: 'm@b.test' };
    render(<OnboardingPage />);
    expect(screen.getByTestId('wizard')).toBeTruthy();
    auth.value.user = { role: 'super_admin', email: 'a@b.test' };
  });
});
