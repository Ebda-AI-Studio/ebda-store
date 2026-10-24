import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { call, cookieOf, login, seedUser } from './helpers';
import { SoftAuthenticator } from './authenticator';

const ADMIN = 'https://store.ebda.app';
const RP = 'store.ebda.app';
// a fresh client IP per call: the per-IP failure throttle is exercised in identity.test.ts, not here
const hdr = (origin = ADMIN) => ({
  origin,
  'cf-connecting-ip': `198.18.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
});

async function enroll(u: { email: string; password: string }, origin = ADMIN) {
  const s = await login(u);
  const auth = await SoftAuthenticator.create();
  const opts = (await (
    await call('/passkey/register/options', {
      json: { password: u.password },
      bearer: s.body.access_token,
      headers: hdr(origin),
    })
  ).json()) as {
    data: {
      challenge: string;
      rp: { id: string };
      authenticatorSelection: { userVerification: string; residentKey: string };
    };
  };
  expect(opts.data.rp.id).toBe(new URL(origin).hostname);
  expect(opts.data.authenticatorSelection).toMatchObject({
    userVerification: 'required',
    residentKey: 'required',
  });
  const reg = await auth.register(
    { challenge: opts.data.challenge, rpId: opts.data.rp.id },
    origin
  );
  const done = await call('/passkey/register/verify', {
    json: { response: reg, name: 'Laptop' },
    bearer: s.body.access_token,
    headers: hdr(origin),
  });
  return { s, auth, done };
}

async function passkeyLogin(
  auth: SoftAuthenticator,
  userId: string,
  origin = ADMIN,
  opts: { counter?: number; handle?: string | null } = {}
) {
  const o = (await (
    await call('/passkey/login/options', { method: 'POST', headers: hdr(origin) })
  ).json()) as { data: { challenge: string; rpId: string } };
  const assertion = await auth.assert(
    { challenge: o.data.challenge, rpId: o.data.rpId },
    origin,
    opts.handle === null ? undefined : (opts.handle ?? userId),
    opts.counter
  );
  return call('/passkey/login/verify', { json: { response: assertion }, headers: hdr(origin) });
}

describe('passkeys', () => {
  it('register (with password step-up) then sign in with no email; the session is a full one and satisfies MFA', async () => {
    const u = await seedUser();
    const { done, auth } = await enroll(u);
    expect(done.status).toBe(201);
    const row = await env.DB.prepare(`SELECT * FROM passkey_credentials WHERE user_id = ?1`)
      .bind(u.id)
      .first<{ rp_id: string; public_key: string; counter: number; credential_id: string }>();
    expect(row!.rp_id).toBe(RP);
    expect(row!.credential_id).toBe(auth.id);
    expect(row!.public_key).toMatch(/^[A-Za-z0-9_-]+$/); // base64url COSE, the Store's encoding
    const res = await passkeyLogin(auth, u.id);
    expect(res.status).toBe(200);
    expect(cookieOf(res)).not.toBe('');
    const body = (await res.json()) as { data: { user: { id: string }; access_token: string } };
    expect(body.data.user.id).toBe(u.id);
    const after = await env.DB.prepare(
      `SELECT counter, last_used_at FROM passkey_credentials WHERE user_id = ?1`
    )
      .bind(u.id)
      .first<{ counter: number; last_used_at: string }>();
    expect(after!.counter).toBe(1);
    expect(after!.last_used_at).toBeTruthy();
  });

  it('even with MFA enabled, a passkey login skips the code step', async () => {
    const u = await seedUser();
    const { auth } = await enroll(u);
    await env.DB.prepare(`UPDATE users SET mfa_enabled = 1, mfa_secret = 'v1.x.y' WHERE id = ?1`)
      .bind(u.id)
      .run();
    expect((await passkeyLogin(auth, u.id)).status).toBe(200);
  });

  it('registration needs the password again and a registered ceremony origin', async () => {
    const u = await seedUser();
    const s = await login(u);
    expect(
      (
        await call('/passkey/register/options', {
          json: { password: 'wrong' },
          bearer: s.body.access_token,
          headers: hdr(),
        })
      ).status
    ).toBe(403);
    const evil = await call('/passkey/register/options', {
      json: { password: u.password },
      bearer: s.body.access_token,
      headers: hdr('https://evil.example'),
    });
    expect(evil.status).toBe(404);
    expect(
      (
        await call('/passkey/login/options', {
          method: 'POST',
          headers: hdr('https://evil.example'),
        })
      ).status
    ).toBe(404);
  });

  it('a replayed assertion fails (challenge is single use) and a regressed counter fails (cloned authenticator)', async () => {
    const u = await seedUser();
    const { auth } = await enroll(u);
    const o = (await (
      await call('/passkey/login/options', { method: 'POST', headers: hdr() })
    ).json()) as { data: { challenge: string; rpId: string } };
    const a = await auth.assert({ challenge: o.data.challenge, rpId: o.data.rpId }, ADMIN, u.id);
    expect(
      (await call('/passkey/login/verify', { json: { response: a }, headers: hdr() })).status
    ).toBe(200);
    expect(
      (await call('/passkey/login/verify', { json: { response: a }, headers: hdr() })).status
    ).toBe(401); // replay
    const clone = await passkeyLogin(auth, u.id, ADMIN, { counter: 1 }); // counter did not advance
    expect(clone.status).toBe(401);
  });

  it('every failure is the same answer: unknown credential, wrong origin, wrong user handle', async () => {
    const u = await seedUser();
    const { auth } = await enroll(u);
    const stranger = await SoftAuthenticator.create();
    const unknown = await passkeyLogin(stranger, u.id);
    const wrongHandle = await passkeyLogin(auth, u.id, ADMIN, { handle: crypto.randomUUID() });
    const o = (await (
      await call('/passkey/login/options', { method: 'POST', headers: hdr() })
    ).json()) as { data: { challenge: string; rpId: string } };
    const a = await auth.assert({ challenge: o.data.challenge, rpId: o.data.rpId }, ADMIN, u.id);
    const wrongOrigin = await call('/passkey/login/verify', {
      json: { response: a },
      headers: hdr('https://orders.ebda.app'),
    });
    const bodies = await Promise.all(
      [unknown, wrongHandle, wrongOrigin].map(async r => ({ s: r.status, b: await r.json() }))
    );
    for (const b of bodies) expect(b.s).toBe(401);
    expect(bodies[0].b).toEqual(bodies[1].b);
    expect(bodies[1].b).toEqual(bodies[2].b);
  });

  it('a credential registered for another origin cannot sign in from this one (rpId is bound)', async () => {
    const u = await seedUser();
    const { auth } = await enroll(u, 'https://orders.ebda.app');
    const res = await passkeyLogin(auth, u.id, ADMIN);
    expect(res.status).toBe(401);
    expect((await passkeyLogin(auth, u.id, 'https://orders.ebda.app')).status).toBe(200);
  });

  it('a suspended account cannot sign in with a passkey; list and delete need the bearer and the password', async () => {
    const u = await seedUser();
    const { auth, s } = await enroll(u);
    const list = (await (await call('/passkeys', { bearer: s.body.access_token })).json()) as {
      data: { passkeys: Array<{ id: string }> };
    };
    expect(list.data.passkeys).toHaveLength(1);
    const id = list.data.passkeys[0].id;
    expect(
      (
        await call(`/passkeys/${id}/delete`, {
          json: { password: 'bad' },
          bearer: s.body.access_token,
        })
      ).status
    ).toBe(403);
    await env.DB.prepare(`UPDATE users SET status = 'suspended' WHERE id = ?1`).bind(u.id).run();
    expect((await passkeyLogin(auth, u.id)).status).toBe(401);
    await env.DB.prepare(`UPDATE users SET status = 'active' WHERE id = ?1`).bind(u.id).run();
    expect(
      (
        await call(`/passkeys/${id}/delete`, {
          json: { password: u.password },
          bearer: s.body.access_token,
        })
      ).status
    ).toBe(200);
    expect((await passkeyLogin(auth, u.id)).status).toBe(401);
  });
});
