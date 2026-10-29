import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { call, fakes, login, seedUser } from './helpers';

// Ruling ID-WA-OTP-1: the password-reset code also goes to the account's own phone over WhatsApp (ebda-wa `WhatsAppOtp`), BESIDE the email, never instead of it.
// Fail closed: no binding, no phone, an unverified address, or no store that can send = no WhatsApp attempt and the email path is unchanged.
const STORE_A = '11111111-1111-4111-8111-111111111111';
const STORE_B = '22222222-2222-4222-8222-222222222222';
const PHONE = '+201001234567';

async function seedWithPhone(
  over: Parameters<typeof seedUser>[0] = {},
  phone: string | null = PHONE
) {
  const u = await seedUser(over);
  if (phone)
    await env.DB.prepare('UPDATE users SET phone = ?2 WHERE id = ?1').bind(u.id, phone).run();
  return u;
}
const forgot = (email: string) => call('/password/forgot', { json: { email } });

beforeEach(() => {
  fakes.mails.length = 0;
  fakes.stores = [{ id: STORE_A, role: 'owner' }];
  fakes.whatsapp = { bound: true, calls: [], results: [{ ok: true }], throws: false };
});

describe('password reset code over WhatsApp', () => {
  it('sends the SAME code by email and by WhatsApp, from the first store of the account, to the phone on file', async () => {
    const u = await seedWithPhone();
    expect((await forgot(u.email)).status).toBe(202);
    expect(fakes.mails).toHaveLength(1);
    expect(fakes.whatsapp.calls).toEqual([
      { storeId: STORE_A, phone: PHONE, code: fakes.mails[0].code },
    ]);
    // the code that arrived by WhatsApp really resets the password
    const reset = await call('/password/reset', {
      json: { email: u.email, code: fakes.whatsapp.calls[0].code, newPassword: 'N3w!Passw0rdXY' },
    });
    expect(reset.status).toBe(200);
  });

  it('fails closed when the binding is absent: no WhatsApp attempt, email unchanged', async () => {
    fakes.whatsapp.bound = false;
    const u = await seedWithPhone();
    expect((await forgot(u.email)).status).toBe(202);
    expect(fakes.mails).toHaveLength(1);
    expect(fakes.whatsapp.calls).toHaveLength(0);
  });

  it('sends nothing over WhatsApp without a phone, for an unverified address, or when the account owns no store', async () => {
    const noPhone = await seedWithPhone({}, null);
    await forgot(noPhone.email);
    const unverified = await seedWithPhone({ emailVerified: 0 });
    await forgot(unverified.email);
    fakes.stores = [];
    const noStore = await seedWithPhone();
    await forgot(noStore.email);
    expect(fakes.whatsapp.calls).toHaveLength(0);
    expect(fakes.mails.length).toBeGreaterThanOrEqual(2); // the email path still runs for the verified ones
  });

  it('only a store the user OWNS may send: a staff role is skipped', async () => {
    fakes.stores = [
      { id: STORE_A, role: 'staff' },
      { id: STORE_B, role: 'owner' },
    ];
    const u = await seedWithPhone();
    await forgot(u.email);
    expect(fakes.whatsapp.calls.map(c => c.storeId)).toEqual([STORE_B]);
  });

  it('a store with no usable sender (no_number / disabled) hands over to the next owned store; any other refusal stops', async () => {
    fakes.stores = [
      { id: STORE_A, role: 'owner' },
      { id: STORE_B, role: 'owner' },
    ];
    fakes.whatsapp.results = [{ ok: false, reason: 'disabled' }, { ok: true }];
    const u = await seedWithPhone();
    await forgot(u.email);
    expect(fakes.whatsapp.calls.map(c => c.storeId)).toEqual([STORE_A, STORE_B]);
    fakes.whatsapp.calls = [];
    fakes.whatsapp.results = [{ ok: false, reason: 'rate_limited' }];
    const v = await seedWithPhone();
    await forgot(v.email);
    expect(fakes.whatsapp.calls).toHaveLength(1); // rate_limited: do not hammer the next store
  });

  it('an RPC that throws or a directory that is down never blocks the email or leaks the code to logs', async () => {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (m: unknown) => {
      lines.push(String(m));
    };
    try {
      fakes.whatsapp.throws = true;
      const u = await seedWithPhone();
      expect((await forgot(u.email)).status).toBe(202);
      expect(fakes.mails).toHaveLength(1);
      const code = fakes.mails[0].code;
      fakes.directoryDown = true;
      const v = await seedWithPhone();
      expect((await forgot(v.email)).status).toBe(202);
      expect(fakes.mails).toHaveLength(2);
      expect(lines.join('\n')).not.toContain(code);
      expect(lines.join('\n')).not.toContain(PHONE);
    } finally {
      console.error = orig;
      fakes.directoryDown = false;
    }
  });

  it('the over-cap path sends nothing anywhere (no code was issued)', async () => {
    const u = await seedWithPhone();
    for (let i = 0; i < 3; i++) await forgot(u.email);
    const sent = fakes.whatsapp.calls.length;
    await call('/password/forgot', { json: { email: u.email } });
    expect(fakes.whatsapp.calls).toHaveLength(sent);
    expect(fakes.mails.length).toBe(sent);
  });
});

describe('what never goes over WhatsApp', () => {
  it('a first-factor enrolment code stays email-only (ID-15: the e-mailed code is the proof of mailbox control)', async () => {
    const u = await seedWithPhone();
    const s = await login(u);
    const r = await call('/mfa/bootstrap/code', {
      json: { password: u.password },
      bearer: s.body.access_token,
    });
    expect(r.status).toBe(202);
    expect(fakes.mails.at(-1)?.kind).toBe('factor_enrol');
    expect(fakes.whatsapp.calls).toHaveLength(0);
  });
  it('a platform admin password reset stays email-only', async () => {
    const admin = await seedWithPhone({ role: 'super_admin' });
    expect((await forgot(admin.email)).status).toBe(202);
    expect(fakes.mails).toHaveLength(1);
    expect(fakes.whatsapp.calls).toHaveLength(0);
  });
  it('signup verification and staff invitations stay email-only (the phone is not yet proven to belong to the mailbox owner)', async () => {
    const r = await call('/signup', {
      json: {
        email: 'new-wa@example.com',
        password: 'Str0ng!Passw0rd',
        firstName: 'A',
        lastName: 'B',
        phone: PHONE,
      },
    });
    expect(r.status).toBeLessThan(300);
    expect(fakes.mails.at(-1)?.kind).toBe('email_verify');
    expect(fakes.whatsapp.calls).toHaveLength(0);
  });
});
