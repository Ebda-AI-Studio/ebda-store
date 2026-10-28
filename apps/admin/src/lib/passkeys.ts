import {
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  startAuthentication,
  startRegistration,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { AccountsError, accountsFetch } from './accounts';

/**
 * Browser half of passkeys for the admin app (server half: apps/accounts/src/passkeys.ts, the shared identity service).
 * The ceremony host is the page's own origin, which is exactly what the identity service reads from `Origin`.
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

/**
 * Sign-in ceremony against the identity service: begin -> browser prompt -> finish. Resolves to a Store access token.
 * The browser sends this page's own origin, which is what the identity service derives the WebAuthn RP ID from (so existing
 * passkeys registered for this host keep working). Rejects with the browser's own error when the prompt is cancelled (see
 * isPasskeyCancel) or with `Error(code)` when the service refuses.
 */
export async function passkeyAssertion(
  mode: PasskeyMode
): Promise<{ access_token: string; expires_at: number }> {
  let options: PublicKeyCredentialRequestOptionsJSON;
  try {
    options = await accountsFetch<PublicKeyCredentialRequestOptionsJSON>('/passkey/login/options', {
      method: 'POST',
      json: {},
    });
  } catch {
    throw new Error('PASSKEY_BEGIN_FAILED');
  }

  const response: AuthenticationResponseJSON = await startAuthentication({
    optionsJSON: options,
    useBrowserAutofill: mode === 'conditional',
  });

  try {
    return await accountsFetch<{ access_token: string; expires_at: number }>(
      '/passkey/login/verify',
      {
        json: { response, aud: 'store' },
      }
    );
  } catch (e) {
    throw new Error(e instanceof AccountsError ? e.code : 'PASSKEY_AUTH_FAILED');
  }
}

/** Run the browser half of a registration ceremony for options the API already issued. */
export const passkeyRegistration = (optionsJSON: PublicKeyCredentialCreationOptionsJSON) =>
  startRegistration({ optionsJSON });
