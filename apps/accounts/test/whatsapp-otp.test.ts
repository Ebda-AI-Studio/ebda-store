import { env } from 'cloudflare:test';
// @ts-expect-error vite raw import
import callerSource from '../src/whatsapp-otp.ts?raw';
import { beforeEach, describe, expect, it } from 'vitest';
import { call, fakes, login, seedUser } from './helpers';

// Rulings ID-WA-OTP-1 + WA-OTP-SENDER-1: the password-reset code also goes to the account's own phone over WhatsApp, from the PLATFORM number only
// (ebda-wa `PlatformOtp.sendCode(phone, code)`, no store id), BESIDE the email. OFF by default (WHATSAPP_OTP_ENABLED) until the platform number exists.
// Fail closed: flag off, no binding, no phone, an unverified address = no WhatsApp attempt and the email path is unchanged.
const STORE_A = '11111111-1111-4111-8111-111111111111';
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
  fakes.directoryDown = false;
  fakes.whatsapp = { bound: true, enabled: true, calls: [], result: { ok: true }, throws: false };
});

describe('password reset code over WhatsApp (platform sender)', () => {
  it('sends the SAME code by email and by WhatsApp to the phone on file, with NO store id in the call', async () => {
    const u = await seedWithPhone();
    expect((await forgot(u.email)).status).toBe(202);
    expect(fakes.mails).toHaveLength(1);
    expect(fakes.whatsapp.calls).toHaveLength(1);
    expect(fakes.whatsapp.calls[0]).toMatchObject({ phone: PHONE, code: fakes.mails[0].code });
    expect(fakes.whatsapp.calls[0].args).toEqual([PHONE, fakes.mails[0].code]); // exactly (phone, code): nothing about a store
    const reset = await call('/password/reset', {
      json: { email: u.email, code: fakes.whatsapp.calls[0].code, newPassword: 'N3w!Passw0rdXY' },
    });
    expect(reset.status).toBe(200);
  });

  it('never consults the Store directory or a store: the caller has no per-store path at all', async () => {
    fakes.directoryDown = true; // would have broken a per-store loop
    fakes.stores = [];
    const u = await seedWithPhone();
    await forgot(u.email);
    expect(fakes.whatsapp.calls).toHaveLength(1);
    const src = (callerSource as string).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(src).not.toMatch(/storesForUser|STORE_DIRECTORY|storeId|store\.id/);
  });

  it('is OFF by default: with the flag not "true" nothing is sent even though the binding exists', async () => {
    fakes.whatsapp.enabled = false;
    const u = await seedWithPhone();
    expect((await forgot(u.email)).status).toBe(202);
    expect(fakes.mails).toHaveLength(1);
    expect(fakes.whatsapp.calls).toHaveLength(0);
  });

  it('fails closed when the binding is absent: no attempt, email unchanged', async () => {
    fakes.whatsapp.bound = false;
    const u = await seedWithPhone();
    expect((await forgot(u.email)).status).toBe(202);
    expect(fakes.mails).toHaveLength(1);
    expect(fakes.whatsapp.calls).toHaveLength(0);
  });

  it('sends nothing over WhatsApp without a phone or for an unverified address', async () => {
    await forgot((await seedWithPhone({}, null)).email);
    await forgot((await seedWithPhone({ emailVerified: 0 })).email);
    expect(fakes.whatsapp.calls).toHaveLength(0);
    expect(fakes.mails.length).toBeGreaterThanOrEqual(1);
  });

  it('a refusal or a throwing RPC never blocks the email and never logs the code or the phone', async () => {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (m: unknown) => {
      lines.push(String(m));
    };
    try {
      fakes.whatsapp.result = { ok: false, reason: 'disabled' };
      const u = await seedWithPhone();
      expect((await forgot(u.email)).status).toBe(202);
      fakes.whatsapp.throws = true;
      const v = await seedWithPhone();
      expect((await forgot(v.email)).status).toBe(202);
      expect(fakes.mails).toHaveLength(2);
      for (const m of fakes.mails) expect(lines.join('\n')).not.toContain(m.code);
      expect(lines.join('\n')).not.toContain(PHONE);
      expect(lines.join('\n')).toContain('disabled');
    } finally {
      console.error = orig;
    }
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
  it('signup verification stays email-only (the phone is not yet proven to belong to the mailbox owner)', async () => {
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
