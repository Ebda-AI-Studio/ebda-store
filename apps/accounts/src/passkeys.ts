/**
 * Passkeys (WebAuthn). Ported from the Store's passkey.service with the same posture: credential-less sign-in
 * (nothing to enumerate), UV required, single-use challenges, origin allow-list, compare-and-set on the counter.
 * rpId = the HOSTNAME of the browser origin the ceremony runs from, exactly as the Store stored it, so existing
 * admin passkeys keep verifying when the verification moves here (the login page must stay on that origin).
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { UserRow } from './data';
import { b64urlDecode, b64urlEncode, csv, iso, nowMs } from './util';

const CHALLENGE_TTL_MS = 5 * 60_000;
export const MAX_PASSKEYS = 10;
const RP_NAME = 'Ebda AI Studio';

export class PasskeyError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string
  ) {
    super(code);
  }
}

export function ceremonyOrigin(
  env: { PASSKEY_ORIGINS: string },
  origin: string | null | undefined
) {
  if (!origin || !csv(env.PASSKEY_ORIGINS).includes(origin))
    throw new PasskeyError(404, 'PASSKEY_NOT_AVAILABLE');
  return { origin, rpId: new URL(origin).hostname };
}

async function putChallenge(
  db: D1Database,
  kind: string,
  challenge: string,
  data: object,
  userId?: string
) {
  // opportunistic cleanup: expired ceremonies never accumulate
  await db.prepare(`DELETE FROM challenges WHERE expires_at < ?1`).bind(nowMs()).run();
  await db
    .prepare(`INSERT INTO challenges (id, kind, user_id, data, expires_at) VALUES (?1,?2,?3,?4,?5)`)
    .bind(challenge, kind, userId ?? null, JSON.stringify(data), nowMs() + CHALLENGE_TTL_MS)
    .run();
}

/** Read and CONSUME in one statement: exactly one of two concurrent finishes can win. */
async function takeChallenge<T>(
  db: D1Database,
  kind: string,
  challenge: string
): Promise<(T & { _userId: string | null }) | null> {
  const row = await db
    .prepare(
      `DELETE FROM challenges WHERE id = ?1 AND kind = ?2 AND expires_at > ?3 RETURNING data, user_id`
    )
    .bind(challenge, kind, nowMs())
    .first<{ data: string; user_id: string | null }>();
  if (!row) return null;
  return { ...(JSON.parse(row.data) as T), _userId: row.user_id };
}

function challengeOf(response: { response?: { clientDataJSON?: unknown } }): string | null {
  const raw = response?.response?.clientDataJSON;
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(b64urlDecode(raw)));
    return typeof parsed?.challenge === 'string' && parsed.challenge.length <= 256
      ? parsed.challenge
      : null;
  } catch {
    return null;
  }
}

const userHandle = (id: string) => new TextEncoder().encode(id) as Uint8Array<ArrayBuffer>;

export async function beginRegistration(
  db: D1Database,
  env: { PASSKEY_ORIGINS: string },
  user: UserRow,
  origin: string | null
) {
  const ctx = ceremonyOrigin(env, origin);
  const existing = await db
    .prepare(`SELECT credential_id, transports, rp_id FROM passkey_credentials WHERE user_id = ?1`)
    .bind(user.id)
    .all<{ credential_id: string; transports: string; rp_id: string }>();
  if (!user.email_verified) throw new PasskeyError(403, 'EMAIL_NOT_VERIFIED');
  if (existing.results.length >= MAX_PASSKEYS) throw new PasskeyError(409, 'PASSKEY_LIMIT');
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: ctx.rpId,
    userName: user.email,
    userDisplayName: `${user.first_name} ${user.last_name}`.trim() || user.email,
    userID: userHandle(user.id),
    attestationType: 'none',
    timeout: CHALLENGE_TTL_MS,
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    excludeCredentials: existing.results
      .filter(c => c.rp_id === ctx.rpId)
      .map(c => ({ id: c.credential_id, transports: JSON.parse(c.transports) as never })),
  });
  await putChallenge(
    db,
    'passkey-register',
    options.challenge,
    { origin: ctx.origin, rpId: ctx.rpId },
    user.id
  );
  return options;
}

export async function finishRegistration(
  db: D1Database,
  user: UserRow,
  origin: string | null,
  body: { response: RegistrationResponseJSON; name?: string }
) {
  if (!user.email_verified) throw new PasskeyError(403, 'EMAIL_NOT_VERIFIED');
  const challenge = challengeOf(body.response as never);
  const rec = challenge
    ? await takeChallenge<{ origin: string; rpId: string }>(db, 'passkey-register', challenge)
    : null;
  if (!challenge || !rec || rec._userId !== user.id || origin !== rec.origin)
    throw new PasskeyError(400, 'PASSKEY_REGISTRATION_FAILED');
  let verified;
  try {
    verified = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: challenge,
      expectedOrigin: rec.origin,
      expectedRPID: rec.rpId,
      requireUserVerification: true,
    });
  } catch {
    throw new PasskeyError(400, 'PASSKEY_REGISTRATION_FAILED');
  }
  if (!verified.verified || !verified.registrationInfo)
    throw new PasskeyError(400, 'PASSKEY_REGISTRATION_FAILED');
  const { credential, credentialDeviceType, credentialBackedUp } = verified.registrationInfo;
  const name =
    (typeof body.name === 'string' ? body.name.replace(/\s+/g, ' ').trim().slice(0, 60) : '') ||
    'Passkey';
  try {
    await db
      .prepare(
        `INSERT INTO passkey_credentials (id, user_id, credential_id, public_key, counter, transports, device_type, backed_up, rp_id, name, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`
      )
      .bind(
        crypto.randomUUID(),
        user.id,
        credential.id,
        b64urlEncode(credential.publicKey),
        credential.counter,
        JSON.stringify(credential.transports ?? []),
        credentialDeviceType,
        credentialBackedUp ? 1 : 0,
        rec.rpId,
        name,
        iso()
      )
      .run();
  } catch {
    throw new PasskeyError(400, 'PASSKEY_REGISTRATION_FAILED');
  }
  return { name };
}

export async function beginAuthentication(
  db: D1Database,
  env: { PASSKEY_ORIGINS: string },
  origin: string | null
) {
  const ctx = ceremonyOrigin(env, origin);
  const options = await generateAuthenticationOptions({
    rpID: ctx.rpId,
    userVerification: 'required',
    timeout: CHALLENGE_TTL_MS,
  });
  await putChallenge(db, 'passkey-login', options.challenge, {
    origin: ctx.origin,
    rpId: ctx.rpId,
  });
  return options;
}

/** Every failure is the same PASSKEY_AUTH_FAILED to the client; the reason is returned for logging only. */
export async function finishAuthentication(
  db: D1Database,
  env: { PASSKEY_ORIGINS: string },
  origin: string | null,
  response: AuthenticationResponseJSON
): Promise<{ user: UserRow } | { fail: string }> {
  const challenge = challengeOf(response as never);
  if (!challenge) return { fail: 'malformed' };
  const rec = await takeChallenge<{ origin: string; rpId: string }>(db, 'passkey-login', challenge);
  if (!rec) return { fail: 'challenge' };
  if (origin !== rec.origin) return { fail: 'origin_mismatch' };
  try {
    ceremonyOrigin(env, origin);
  } catch {
    return { fail: 'context' };
  }
  const stored = await db
    .prepare(`SELECT * FROM passkey_credentials WHERE credential_id = ?1`)
    .bind(typeof response.id === 'string' ? response.id : '')
    .first<{
      id: string;
      user_id: string;
      public_key: string;
      counter: number;
      transports: string;
      rp_id: string;
    }>();
  if (!stored) return { fail: 'unknown_credential' };
  if (stored.rp_id !== rec.rpId) return { fail: 'rp_mismatch' };
  const user = await db
    .prepare(`SELECT * FROM users WHERE id = ?1 AND deleted_at IS NULL`)
    .bind(stored.user_id)
    .first<UserRow>();
  if (!user || user.status !== 'active' || !user.email_verified) return { fail: 'account' };
  const handle = response.response?.userHandle;
  if (handle && new TextDecoder().decode(b64urlDecode(handle)) !== user.id)
    return { fail: 'user_handle' };
  let verified;
  try {
    verified = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rec.origin,
      expectedRPID: rec.rpId,
      requireUserVerification: true,
      credential: {
        id: response.id,
        publicKey: b64urlDecode(stored.public_key) as Uint8Array<ArrayBuffer>,
        counter: stored.counter,
        transports: JSON.parse(stored.transports) as never,
      },
    });
  } catch (e) {
    return {
      fail: /counter/i.test(e instanceof Error ? e.message : '')
        ? 'counter_regression'
        : 'verification',
    };
  }
  if (!verified.verified) return { fail: 'verification' };
  const next = verified.authenticationInfo.newCounter;
  // Compare-and-set on the sign count: two racing assertions cannot both advance it.
  const res = await db
    .prepare(
      `UPDATE passkey_credentials SET counter = ?2, last_used_at = ?3, backed_up = ?4
       WHERE id = ?1 AND (?2 = 0 OR counter < ?2)`
    )
    .bind(stored.id, next, iso(), verified.authenticationInfo.credentialBackedUp ? 1 : 0)
    .run();
  if ((res.meta.changes ?? 0) !== 1) return { fail: 'counter_race' };
  return { user };
}

export async function listPasskeys(db: D1Database, userId: string) {
  const r = await db
    .prepare(
      `SELECT id, name, rp_id, device_type, backed_up, created_at, last_used_at FROM passkey_credentials WHERE user_id = ?1 ORDER BY created_at`
    )
    .bind(userId)
    .all();
  return r.results;
}

export async function removePasskey(db: D1Database, userId: string, id: string): Promise<boolean> {
  const r = await db
    .prepare(`DELETE FROM passkey_credentials WHERE id = ?1 AND user_id = ?2`)
    .bind(id, userId)
    .run();
  return (r.meta.changes ?? 0) === 1;
}

export async function renamePasskey(
  db: D1Database,
  userId: string,
  id: string,
  name: string
): Promise<boolean> {
  const clean = name.replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!clean) return false;
  const r = await db
    .prepare(`UPDATE passkey_credentials SET name = ?3 WHERE id = ?1 AND user_id = ?2`)
    .bind(id, userId, clean)
    .run();
  return (r.meta.changes ?? 0) === 1;
}
