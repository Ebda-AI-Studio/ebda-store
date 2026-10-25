/** MFA key versioning and rotation: the sealed secret names its key, a keyring opens it, a job re-seals it, nothing is lost mid-flight. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { call, fakes, login, seedUser } from './helpers';
import { keyId, needsReseal, seal, sealCurrent, totpAt, unsealAny } from '../src/totp';
import { reencryptMfaSecrets } from '../src/mfa-keys';

const rndKey = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const K1 = env.MFA_KEY as string;
let K2 = rndKey();

beforeEach(() => {
  K2 = rndKey();
  fakes.envOverride = {};
});
afterEach(() => {
  fakes.envOverride = {};
});

const row = (id: string) =>
  env.DB.prepare(`SELECT mfa_secret FROM users WHERE id = ?1`)
    .bind(id)
    .first<{ mfa_secret: string | null }>();

async function enrol(u: { id: string; email: string; password: string }) {
  const s = await login(u);
  const bearer = s.body.access_token;
  const secret = (
    (await (await call('/mfa/enroll', { json: { password: u.password }, bearer })).json()) as {
      data: { secret: string };
    }
  ).data.secret;
  return { bearer, secret };
}
async function finish(u: { id: string; email: string }, bearer: string, secret: string) {
  // first factor of a merchant needs the e-mailed code (Ruling ID-15)
  const c = await call('/mfa/bootstrap/code', { json: { password: 'Str0ng!Passw0rd' }, bearer });
  expect(c.status).toBe(202);
  const emailCode = fakes.mails.at(-1)!.code;
  const r = await call('/mfa/enroll/verify', {
    json: { code: await totpAt(secret), emailCode },
    bearer,
  });
  expect(r.status).toBe(200);
  await env.DB.prepare(`UPDATE users SET mfa_last_step = NULL WHERE id = ?1`).bind(u.id).run();
}
async function loginWithTotp(u: { email: string; password: string }, secret: string) {
  const first = (await (
    await call('/login', { json: { email: u.email, password: u.password } })
  ).json()) as {
    data: { challenge: string };
  };
  await env.DB.prepare(`UPDATE users SET mfa_last_step = NULL WHERE lower(email) = lower(?1)`)
    .bind(u.email)
    .run();
  return call('/login/mfa', {
    json: { challenge: first.data.challenge, code: await totpAt(secret) },
  });
}

describe('sealed format and keyring', () => {
  it('seals as v2 naming the key; opens with that key; the kid is derived from the key bytes', async () => {
    const sealed = await seal(K1, 'JBSWY3DPEHPK3PXP');
    expect(sealed.startsWith(`v2.${await keyId(K1)}.`)).toBe(true);
    expect(await unsealAny({ MFA_KEY: K1 }, sealed)).toBe('JBSWY3DPEHPK3PXP');
    expect(await keyId(K1)).not.toBe(await keyId(K2));
  });

  it('opens with the previous key during a rotation, and refuses a key that is in neither slot', async () => {
    const sealed = await seal(K1, 'SECRET');
    expect(await unsealAny({ MFA_KEY: K2, MFA_KEY_PREV: K1 }, sealed)).toBe('SECRET');
    await expect(unsealAny({ MFA_KEY: K2 }, sealed)).rejects.toThrow();
    await expect(unsealAny({ MFA_KEY: K2, MFA_KEY_PREV: rndKey() }, sealed)).rejects.toThrow();
  });

  it('still opens legacy v1 secrets (no kid) with the right key from the ring', async () => {
    // build a v1 by hand: v1.<iv>.<ct> with K1
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const raw = Uint8Array.from(atob(K1), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('LEGACY'))
    );
    const b64u = (b: Uint8Array) =>
      btoa(String.fromCharCode(...b))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/, '');
    const v1 = `v1.${b64u(iv)}.${b64u(ct)}`;
    expect(await unsealAny({ MFA_KEY: K2, MFA_KEY_PREV: K1 }, v1)).toBe('LEGACY');
    expect(await needsReseal({ MFA_KEY: K1 }, v1)).toBe(true); // v1 is always re-sealed as v2
  });

  it('encrypts with the CURRENT key only (the previous one never seals)', async () => {
    const s = await sealCurrent({ MFA_KEY: K2, MFA_KEY_PREV: K1 }, 'X');
    expect(s.startsWith(`v2.${await keyId(K2)}.`)).toBe(true);
  });
});

describe('rotation mid-flight', () => {
  it('an enrolled user keeps signing in through the rotation, the job re-seals, and the previous key can then be dropped', async () => {
    const u = await seedUser();
    const { bearer, secret } = await enrol(u);
    await finish(u, bearer, secret);
    expect((await row(u.id))!.mfa_secret!.startsWith(`v2.${await keyId(K1)}.`)).toBe(true);

    // rotation starts: K2 current, K1 previous. Existing secrets still open.
    fakes.envOverride = { MFA_KEY: K2, MFA_KEY_PREV: K1 };
    expect((await loginWithTotp(u, secret)).status).toBe(200);

    // the re-encrypt job moves it to K2
    const rep = await reencryptMfaSecrets({ ...env, MFA_KEY: K2, MFA_KEY_PREV: K1 } as never);
    expect(rep.resealed).toBeGreaterThanOrEqual(1);
    expect(rep.remaining).toBe(0);
    expect((await row(u.id))!.mfa_secret!.startsWith(`v2.${await keyId(K2)}.`)).toBe(true);

    // the previous key is dropped: sign-in still works on K2 alone
    fakes.envOverride = { MFA_KEY: K2 };
    expect((await loginWithTotp(u, secret)).status).toBe(200);
  });

  it('an enrolment begun BEFORE the rotation completes AFTER it', async () => {
    const u = await seedUser();
    const { bearer, secret } = await enrol(u); // pending secret sealed with K1
    fakes.envOverride = { MFA_KEY: K2, MFA_KEY_PREV: K1 }; // rotation happens now
    await finish(u, bearer, secret);
    // enrolled; the secret is still K1-sealed until the job runs, and signs in
    expect((await loginWithTotp(u, secret)).status).toBe(200);
    await reencryptMfaSecrets({ ...env, MFA_KEY: K2, MFA_KEY_PREV: K1 } as never);
    fakes.envOverride = { MFA_KEY: K2 };
    expect((await loginWithTotp(u, secret)).status).toBe(200);
  });

  it('a rotation that forgot the previous key fails CLOSED with a 503, never a pass and never a 500', async () => {
    const u = await seedUser();
    const { bearer, secret } = await enrol(u);
    await finish(u, bearer, secret);
    fakes.envOverride = { MFA_KEY: K2 }; // K1 dropped before the job ran
    const first = (await (
      await call('/login', { json: { email: u.email, password: u.password } })
    ).json()) as {
      data: { challenge: string };
    };
    const r = await call('/login/mfa', {
      json: { challenge: first.data.challenge, code: await totpAt(secret) },
    });
    expect(r.status).toBe(503);
    // putting K1 back as previous restores service with no data loss
    fakes.envOverride = { MFA_KEY: K2, MFA_KEY_PREV: K1 };
    expect((await loginWithTotp(u, secret)).status).toBe(200);
  });
});

describe('re-encrypt job', () => {
  it('is compare-and-set: a secret that changes while the job runs is never overwritten', async () => {
    const u = await seedUser();
    const sealedOld = await seal(K1, 'OLDSECRET');
    await env.DB.prepare(`UPDATE users SET mfa_secret = ?2, mfa_enabled = 1 WHERE id = ?1`)
      .bind(u.id, sealedOld)
      .run();
    const changed = await seal(K1, 'NEWSECRET'); // the user re-enrolled meanwhile
    // a DB wrapper that changes the row right after the job has READ it
    const db = env.DB;
    const proxy = new Proxy(db, {
      get(t, p) {
        if (p !== 'prepare') return (t as never)[p];
        return (sql: string) => {
          const st = db.prepare(sql);
          if (!/^SELECT id, mfa_secret/.test(sql)) return st;
          return new Proxy(st, {
            get(s, q) {
              if (q !== 'bind') return (s as never)[q];
              return (...a: unknown[]) => {
                const b = (s as unknown as { bind: (...x: unknown[]) => D1PreparedStatement }).bind(
                  ...a
                );
                return new Proxy(b, {
                  get(bs, k) {
                    if (k !== 'all') return (bs as never)[k];
                    return async () => {
                      const res = await bs.all();
                      await db
                        .prepare(`UPDATE users SET mfa_secret = ?2 WHERE id = ?1`)
                        .bind(u.id, changed)
                        .run();
                      return res;
                    };
                  },
                });
              };
            },
          });
        };
      },
    });
    const rep = await reencryptMfaSecrets({ DB: proxy, MFA_KEY: K2, MFA_KEY_PREV: K1 } as never);
    expect(rep.skipped).toBeGreaterThanOrEqual(1);
    expect((await row(u.id))!.mfa_secret).toBe(changed); // not clobbered by the stale re-seal
  });

  it('is idempotent and a no-op without a current key; a row it cannot open is reported, not destroyed', async () => {
    const u = await seedUser();
    const bad = await seal(rndKey(), 'FOREIGN'); // sealed with a key we do not hold
    await env.DB.prepare(`UPDATE users SET mfa_secret = ?2, mfa_enabled = 1 WHERE id = ?1`)
      .bind(u.id, bad)
      .run();
    const rep = await reencryptMfaSecrets({ ...env, MFA_KEY: K2, MFA_KEY_PREV: K1 } as never);
    expect(rep.failed).toBeGreaterThanOrEqual(1);
    expect((await row(u.id))!.mfa_secret).toBe(bad);
    const none = await reencryptMfaSecrets({ DB: env.DB } as never);
    expect(none).toMatchObject({ scanned: 0, resealed: 0 });
    await env.DB.prepare(`UPDATE users SET mfa_secret = NULL, mfa_enabled = 0 WHERE id = ?1`)
      .bind(u.id)
      .run();
  });
});
