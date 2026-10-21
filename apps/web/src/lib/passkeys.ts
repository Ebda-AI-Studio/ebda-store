import {
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';

/**
 * Browser half of storefront passkeys (server half: apps/api/src/services/passkey.service.ts).
 * The relying party is THIS storefront host (slug host or custom domain): the API reads it from `Origin`,
 * so a passkey made here works only here (Ruling PASSKEY-3).
 */

export const passkeysSupported = (): boolean =>
  typeof window !== 'undefined' && browserSupportsWebAuthn();

export const passkeyAutofillSupported = async (): Promise<boolean> =>
  passkeysSupported() && (await browserSupportsWebAuthnAutofill());

/** The person dismissed the prompt, picked nothing, or a newer ceremony replaced this one. */
export function isPasskeyCancel(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === 'NotAllowedError' || name === 'AbortError';
}

export const runPasskeyAuthentication = (
  optionsJSON: PublicKeyCredentialRequestOptionsJSON,
  conditional: boolean
) => startAuthentication({ optionsJSON, useBrowserAutofill: conditional });

export const runPasskeyRegistration = (optionsJSON: PublicKeyCredentialCreationOptionsJSON) =>
  startRegistration({ optionsJSON });
