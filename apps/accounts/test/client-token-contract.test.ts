/**
 * Pins the CLIENT token a product receives (identity contract v1.3 r2): the real path (POST /stores/:id/clients, then POST
 * /oauth/token, the code production runs, with a TEST key). The decoded header and payload with the volatile values replaced by
 * fixed examples must equal docs/contracts/identity-client-token-v1.3.example.json, which the WhatsApp verifier asserts against.
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import example from '../../../docs/contracts/identity-client-token-v1.3.example.json';
import { call, fakes, login, seedUser, verifyAsProduct } from './helpers';

const STORE = '11111111-1111-4111-8111-111111111111';

describe('identity client token contract v1.3 (aud=whatsapp)', () => {
  it('the real issuing path produces exactly the documented shape', async () => {
    fakes.stores = [{ id: STORE, role: 'owner' }];
    const u = await seedUser();
    const s = await login(u, 'whatsapp');
    await env.DB.prepare(`UPDATE sessions SET amr='pwd,otp' WHERE user_id=?1`).bind(u.id).run();
    const created = await call(`/stores/${STORE}/clients`, {
      bearer: s.body.access_token,
      json: { name: 'ERP', audience: 'whatsapp', scopes: ['messages:send', 'contacts:read'] },
    });
    expect(created.status).toBe(201);
    const { client_id, client_secret } = (
      (await created.json()) as {
        data: { client_id: string; client_secret: string };
      }
    ).data;
    const res = await call('/oauth/token', {
      form: 'grant_type=client_credentials&audience=whatsapp',
      headers: { authorization: 'Basic ' + btoa(`${client_id}:${client_secret}`) },
    });
    expect(res.status).toBe(200);
    const token = ((await res.json()) as { access_token: string }).access_token;
    const header = decodeProtectedHeader(token);
    const p = decodeJwt(token) as Record<string, unknown>;

    expect(p.sub).toBe(client_id);
    expect(p.sid).toBe(client_id);
    expect(p.nbf).toBe(p.iat);
    expect((p.exp as number) - (p.iat as number)).toBe(600);
    for (const k of ['pa', 'auth_time', 'email', 'email_verified']) expect(p).not.toHaveProperty(k);
    await verifyAsProduct(token, 'whatsapp');

    const iat = 1790000000;
    const shape = {
      header: { ...header, kid: 'ebda-id-YYYY-MM-DD-xxxxxxxx' },
      payload: {
        ...p,
        sub: 'cli_AAAAAAAAAAAAAAAAAAAAAAAAAA',
        sid: 'cli_AAAAAAAAAAAAAAAAAAAAAAAAAA',
        jti: '00000000-0000-4000-8000-0000000000c3',
        iat,
        nbf: iat,
        exp: iat + 600,
      },
    };
    expect(shape).toEqual(example);
  });
});
