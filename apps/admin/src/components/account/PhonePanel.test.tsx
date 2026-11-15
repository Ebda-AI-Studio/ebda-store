// @vitest-environment jsdom
/**
 * G12: the account phone input is type="tel", which never validates. An e-mail typed into "New phone number" used to be
 * accepted client-side and sent to the identity service. The panel now refuses it before any request.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({ posts: [] as unknown[] }));

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('../../lib/accounts', () => ({
  AccountsError: class extends Error {},
  accountsToken: async () => ({ access_token: 'tok', expires_at: Date.now() + 60_000 }),
  accountsFetch: async (path: string, init: { json?: unknown }) => {
    if (path === '/me') return { user: { phone: null } };
    h.posts.push(init?.json);
    return { phone: '+201001234567' };
  },
}));

import { ToastProvider } from '@ebda/ui';
import { PhonePanel } from './PhonePanel';

afterEach(() => {
  cleanup();
  h.posts = [];
});

function fill(phone: string) {
  render(
    <ToastProvider>
      <PhonePanel mfaEnabled={false} />
    </ToastProvider>
  );
  fireEvent.change(document.getElementById('phone-new') as HTMLInputElement, {
    target: { value: phone },
  });
  fireEvent.change(document.getElementById('phone-password') as HTMLInputElement, {
    target: { value: 'pw' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'save' }));
}

describe('PhonePanel phone validation (G12)', () => {
  it('carries the phone keypad attributes', () => {
    render(
      <ToastProvider>
        <PhonePanel mfaEnabled={false} />
      </ToastProvider>
    );
    const el = document.getElementById('phone-new') as HTMLInputElement;
    expect([el.type, el.inputMode, el.autocomplete]).toEqual(['tel', 'tel', 'tel']);
  });

  it('an e-mail is rejected with the invalid-phone message and never sent', async () => {
    fill('someone@example.com');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('errorInvalid'));
    expect(h.posts).toHaveLength(0);
  });

  it('a real phone number is sent', async () => {
    fill('+20 100 123 4567');
    await waitFor(() => expect(h.posts).toHaveLength(1));
  });
});
