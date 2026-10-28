/**
 * Pins the token a PRODUCT receives (identity token contract v1.2): the real issuing path (POST /login -> mintFor -> mintAccessToken,
 * the code production runs, with a TEST key) for aud=whatsapp and a user who OWNS one store and is STAFF on another. The decoded header and
 * payload (no signature), with the volatile values replaced by fixed examples, must equal docs/contracts/identity-token-v1.2.example.json,
 * which the WhatsApp verifier asserts against. Change the token, change the file and the contract together.
 */
import { describe, it, expect } from 'vitest';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import example from '../../../docs/contracts/identity-token-v1.2.example.json';
import { call, fakes, seedUser, verifyAsProduct } from './helpers';

const OWN = '11111111-1111-4111-8111-111111111111';
const STAFF = '22222222-2222-4222-8222-222222222222';

describe('identity token contract v1.2 (aud=whatsapp)', () => {
  it('the real issuing path produces exactly the documented shape', async () => {
    fakes.stores = [
      { id: OWN, role: 'owner' },
      { id: STAFF, role: 'staff' },
    ];
    const u = await seedUser();
    const res = await call('/login', {
      json: { email: u.email, password: u.password, aud: 'whatsapp' },
      headers: { origin: 'https://wa.ebda.app' },
    });
    expect(res.status).toBe(200);
    const token = ((await res.json()) as { data: { access_token: string } }).data.access_token;
    const header = decodeProtectedHeader(token);
    const p = decodeJwt(token) as Record<string, unknown>;

    // relationships that hold for EVERY token (not just the example)
    expect(p.iss).toBe('https://accounts.ebda.app');
    expect(p.aud).toBe('whatsapp');
    expect(p.nbf).toBe(p.iat);
    expect((p.exp as number) - (p.iat as number)).toBe(900); // 15 minutes
    expect(p.auth_time).toBeTypeOf('number');
    expect(p.stores).toEqual([
      { id: OWN, role: 'owner' },
      { id: STAFF, role: 'staff' },
    ]);
    expect(p.pa).toBeUndefined(); // a merchant has no platform role
    // and it verifies the way a product verifies it
    await verifyAsProduct(token, 'whatsapp');

    const iat = 1790000000;
    const shape = {
      header: { ...header, kid: 'ebda-id-YYYY-MM-DD-xxxxxxxx' },
      payload: {
        ...p,
        iss: p.iss,
        sub: '00000000-0000-4000-8000-0000000000a1',
        sid: '00000000-0000-4000-8000-0000000000b2',
        jti: '00000000-0000-4000-8000-0000000000c3',
        iat,
        nbf: iat,
        exp: iat + 900,
        auth_time: iat,
        email: 'merchant@example.com',
        stores: [
          { id: '11111111-1111-4111-8111-111111111111', role: 'owner' },
          { id: '22222222-2222-4222-8222-222222222222', role: 'staff' },
        ],
      },
    };
    expect(shape).toEqual(example);
  });
});
