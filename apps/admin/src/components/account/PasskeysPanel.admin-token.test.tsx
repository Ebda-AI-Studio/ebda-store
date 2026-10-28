// @vitest-environment jsdom
/**
 * Ruling ID-15: the FIRST sign-in factor of an account needs a code e-mailed to it, and a platform administrator's also the
 * operator's one-time enrolment token. The panel shows exactly those fields and sends them with the registration.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; json: Record<string, unknown> }>,
  passkeys: [] as unknown[],
  requiresSignIn: false,
}));

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('../../lib/accounts', () => ({
  AccountsError: class extends Error {},
  accountsToken: async () => ({ access_token: 'tok', expires_at: Date.now() + 60_000 }),
  accountsFetch: async (path: string, init: { json?: Record<string, unknown> }) => {
    h.calls.push({ path, json: init?.json ?? {} });
    if (path === '/passkeys') return { passkeys: h.passkeys };
    if (path === '/passkey/register/options') return { challenge: 'c' };
    if (path === '/passkey/register/verify') return { requiresSignIn: h.requiresSignIn };
    return { ok: true };
  },
}));
vi.mock('../../lib/passkeys', () => ({
  passkeysSupported: () => true,
  isPasskeyCancel: () => false,
  passkeyRegistration: async () => ({ id: 'cred' }),
}));

import { ToastProvider } from '@ebda/ui';
import { PasskeysPanel } from './PasskeysPanel';

beforeEach(() => {
  h.calls = [];
  h.passkeys = [];
  h.requiresSignIn = false;
});
afterEach(cleanup);

async function openStepUp(isAdmin: boolean, onSignInAgain?: () => void) {
  render(
    <ToastProvider>
      <PasskeysPanel mfaEnabled={false} isAdmin={isAdmin} onSignInAgain={onSignInAgain} />
    </ToastProvider>
  );
  await waitFor(() => expect(screen.getByText('empty')).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'add' }));
  await waitFor(() => expect(document.getElementById('passkey-stepup-password')).toBeTruthy());
}

describe('PasskeysPanel first-factor step', () => {
  it('a platform admin sees the e-mailed code AND the operator token fields', async () => {
    await openStepUp(true);
    expect(document.getElementById('passkey-email-code')).toBeTruthy();
    expect(document.getElementById('passkey-enrol-token')).toBeTruthy();
  });

  it('an ordinary merchant sees the e-mailed code field and NO token field', async () => {
    await openStepUp(false);
    expect(document.getElementById('passkey-email-code')).toBeTruthy();
    expect(document.getElementById('passkey-enrol-token')).toBeNull();
  });

  it('confirm stays disabled until the password, the 6-digit code and (admin) the token are filled', async () => {
    await openStepUp(true);
    const confirm = screen.getByRole('button', { name: 'stepUpConfirm' }) as HTMLButtonElement;
    const type = (id: string, value: string) =>
      fireEvent.change(document.getElementById(id) as HTMLInputElement, { target: { value } });
    expect(confirm.disabled).toBe(true);
    type('passkey-stepup-password', 'Correct-Horse-9!');
    type('passkey-email-code', '123456');
    expect(confirm.disabled).toBe(true); // the token is still missing
    type('passkey-enrol-token', 'operator-token');
    expect(confirm.disabled).toBe(false);
  });

  it('sends the e-mailed code and the token with the registration, and never the password in the verify call', async () => {
    await openStepUp(true);
    const type = (id: string, value: string) =>
      fireEvent.change(document.getElementById(id) as HTMLInputElement, { target: { value } });
    type('passkey-stepup-password', 'Correct-Horse-9!');
    type('passkey-email-code', '123456');
    type('passkey-enrol-token', 'operator-token');
    fireEvent.click(screen.getByRole('button', { name: 'stepUpConfirm' }));
    await waitFor(() =>
      expect(h.calls.some(c => c.path === '/passkey/register/verify')).toBe(true)
    );
    const options = h.calls.find(c => c.path === '/passkey/register/options')!;
    expect(options.json.password).toBe('Correct-Horse-9!');
    const verify = h.calls.find(c => c.path === '/passkey/register/verify')!;
    expect(verify.json).toMatchObject({ emailCode: '123456', enrolmentToken: 'operator-token' });
    expect(verify.json.password).toBeUndefined();
  });

  it("a platform admin's first passkey ends every session: the panel asks the page to sign them out", async () => {
    h.requiresSignIn = true;
    const signOut = vi.fn();
    await openStepUp(true, signOut);
    const type = (id: string, value: string) =>
      fireEvent.change(document.getElementById(id) as HTMLInputElement, { target: { value } });
    type('passkey-stepup-password', 'Correct-Horse-9!');
    type('passkey-email-code', '123456');
    type('passkey-enrol-token', 'operator-token');
    fireEvent.click(screen.getByRole('button', { name: 'stepUpConfirm' }));
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
  });
});
