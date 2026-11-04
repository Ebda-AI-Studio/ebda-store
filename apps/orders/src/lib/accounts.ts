/**
 * Browser client for the shared identity service (accounts.ebda.app, Rulings ID-1/ID-2).
 *
 * The identity service owns the credentials and the long-lived session (a host-only HttpOnly cookie on accounts.ebda.app);
 * this app only ever holds a 5-minute access token for the Store (`aud=store`). After each sign-in or silent refresh the
 * token is exchanged for the Store API's own HttpOnly cookie with `POST /auth/session`, so every existing request keeps
 * working unchanged. No password or refresh token is ever stored in JS.
 */
export const accountsUrl = (): string =>
  (process.env.NEXT_PUBLIC_ACCOUNTS_URL || 'https://accounts.ebda.app').replace(/\/$/, '');

export class AccountsError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AccountsError';
  }
}

type Envelope<T> = { success?: boolean; data?: T; error?: { code?: string; message?: string } };

export async function accountsFetch<T>(
  path: string,
  init: { method?: 'GET' | 'POST'; json?: unknown; bearer?: string } = {}
): Promise<T> {
  const res = await fetch(`${accountsUrl()}${path}`, {
    method: init.method ?? (init.json !== undefined ? 'POST' : 'GET'),
    credentials: 'include',
    headers: {
      ...(init.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(init.bearer ? { Authorization: `Bearer ${init.bearer}` } : {}),
    },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  let body: Envelope<T> = {};
  try {
    body = (await res.json()) as Envelope<T>;
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok || body.success === false)
    throw new AccountsError(
      res.status,
      body.error?.code ?? 'REQUEST_FAILED',
      body.error?.message ?? 'Request failed'
    );
  return body.data as T;
}

export interface AccessGrant {
  access_token: string;
  expires_at: number;
}
export type LoginResult =
  | ({ mfaRequired?: false } & AccessGrant)
  | { mfaRequired: true; challenge: string };

export const accountsLogin = (email: string, password: string): Promise<LoginResult> =>
  accountsFetch('/login', { json: { email, password, aud: 'store' } });

/** A 6 digit value is a TOTP code, anything else is treated as a backup code. */
export const accountsLoginMfa = (challenge: string, value: string): Promise<AccessGrant> =>
  accountsFetch('/login/mfa', {
    json: /^\d{6}$/.test(value.trim())
      ? { challenge, code: value.trim() }
      : { challenge, backupCode: value.trim() },
  });

/** A fresh Store access token for the current accounts session, or throws AccountsError(401 NO_SESSION) when signed out. */
export const accountsToken = (): Promise<AccessGrant> => accountsFetch('/token?aud=store');

export const accountsLogout = (bearer?: string): Promise<unknown> =>
  accountsFetch('/logout', { json: {}, bearer });

/** Exchange an access token for the Store API cookie; resolves to the Store profile and the token's expiry. */
export async function establishApiSession<U = unknown>(accessToken: string): Promise<U> {
  const res = await fetch(
    `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'}/api/v1/auth/session`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );
  if (res.status === 429) throw new AccountsError(429, 'THROTTLED', 'Rate limited');
  const body = (await res.json().catch(() => ({}))) as Envelope<{ user: U }>;
  if (!res.ok || !body.data)
    throw new AccountsError(
      res.status,
      body.error?.code ?? 'SESSION_FAILED',
      body.error?.message ?? 'Session failed'
    );
  return body.data.user;
}
