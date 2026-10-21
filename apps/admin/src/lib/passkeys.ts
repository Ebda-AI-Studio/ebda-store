import {
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  startAuthentication,
  startRegistration,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';

/**
 * Browser half of passkeys for the admin app (server half: apps/api/src/services/passkey.service.ts).
 * The ceremony host is the page's own origin, which is exactly what the API reads from `Origin`.
 */

export type PasskeyMode = 'modal' | 'conditional';

export const passkeysSupported = (): boolean =>
  typeof window !== 'undefined' && browserSupportsWebAuthn();

export const passkeyAutofillSupported = async (): Promise<boolean> =>
  passkeysSupported() && (await browserSupportsWebAuthnAutofill());

/** The person dismissed the prompt, picked nothing, or a newer ceremony replaced this one. */
export function isPasskeyCancel(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === 'NotAllowedError' || name === 'AbortError';
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * Sign-in ceremony against the API: begin -> browser prompt -> finish. Resolves to the API's
 * `{ data }` (a full session, like /auth/login). Rejects with the browser's own error when the
 * prompt is cancelled (see isPasskeyCancel) or with `Error(code)` when the API refuses.
 */
export async function passkeyAssertion(apiBase: string, mode: PasskeyMode) {
  const begin = await fetch(`${apiBase}/auth/passkeys/authenticate/begin`, {
    method: 'POST',
    credentials: 'include',
    headers: JSON_HEADERS,
    body: '{}',
  });
  if (!begin.ok) throw new Error('PASSKEY_BEGIN_FAILED');
  const options = (await begin.json()).data as PublicKeyCredentialRequestOptionsJSON;

  const response: AuthenticationResponseJSON = await startAuthentication({
    optionsJSON: options,
    useBrowserAutofill: mode === 'conditional',
  });

  const finish = await fetch(`${apiBase}/auth/passkeys/authenticate/finish`, {
    method: 'POST',
    credentials: 'include',
    headers: JSON_HEADERS,
    body: JSON.stringify({ response }),
  });
  let body: { data?: unknown; error?: { code?: string } } = {};
  try {
    body = await finish.json();
  } catch {
    /* non-JSON error page */
  }
  if (!finish.ok) throw new Error(body.error?.code ?? 'PASSKEY_AUTH_FAILED');
  return body as { data: never };
}

/** Run the browser half of a registration ceremony for options the API already issued. */
export const passkeyRegistration = (optionsJSON: PublicKeyCredentialCreationOptionsJSON) =>
  startRegistration({ optionsJSON });
