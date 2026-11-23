/**
 * Accounts.inviteChatMember (Ruling CHAT-SA-6): Chat invites a team member by email into a standalone workspace.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { call, fakes, seedUser, testEnv } from './helpers';
import { Accounts } from '../src/index';

const rpc = () => new Accounts({} as never, testEnv());
const WS = 'Acme Support';
const mail = () => `chat-${crypto.randomUUID().slice(0, 8)}@example.com`;
const row = (email: string) =>
  env.DB.prepare(
    `SELECT id, role, status, email_verified, password_hash FROM users WHERE lower(email) = lower(?1)`
  )
    .bind(email)
    .first<{
      id: string;
      role: string;
      status: string;
      email_verified: number;
      password_hash: string;
    }>();

beforeEach(() => {
  fakes.mails.length = 0;
  fakes.notices.length = 0;
});

describe('inviteChatMember', () => {
  it('NEW address: creates a credential-less unverified staff identity and mails the single-use set-password code', async () => {
    const email = mail();
    const r = await rpc().inviteChatMember({ email, firstName: 'Sam', workspaceName: WS });
    const u = await row(email);
    expect(r).toEqual({ userId: u!.id });
    expect(u).toMatchObject({
      role: 'staff',
      status: 'active',
      email_verified: 0,
      password_hash: '!pending',
    });
    expect(fakes.mails).toHaveLength(1);
    expect(fakes.mails[0]).toMatchObject({
      to: email,
      kind: 'staff_invite',
      ttlMinutes: 1440,
      storeName: WS,
    });
    expect(fakes.notices).toHaveLength(0);
    // the code sets the password once, verifies the address; a second use fails
    const code = fakes.mails[0].code;
    const pw = 'Str0ng!Passw0rd';
    const ok = await call('/password/reset', { json: { email, code, newPassword: pw } });
    expect(ok.status).toBe(200);
    const again = await call('/password/reset', {
      json: { email, code, newPassword: 'An0ther!Passw0rd' },
    });
    expect(again.status).toBe(400);
    expect((await row(email))!.email_verified).toBe(1);
  });

  it('EXISTING verified identity: returns its id, mails an "added" notice (no code), changes nothing', async () => {
    const v = await seedUser();
    const before = await row(v.email);
    const r = await rpc().inviteChatMember({ email: v.email, firstName: 'X', workspaceName: WS });
    expect(r).toEqual({ userId: v.id });
    expect(fakes.notices).toEqual([
      { to: v.email, kind: 'chat_member_added', factor: undefined, workspaceName: WS },
    ]);
    expect(fakes.mails).toHaveLength(0);
    expect(await row(v.email)).toEqual(before);
  });

  it('EXISTING unverified identity (abandoned signup): bound to its own id, code mailed to the mailbox', async () => {
    const email = mail();
    await call('/signup', { json: { email, password: 'Str0ng!Passw0rd', firstName: 'A' } });
    fakes.mails.length = 0;
    const id = (await row(email))!.id;
    const r = await rpc().inviteChatMember({ email, firstName: 'B', workspaceName: WS });
    expect(r).toEqual({ userId: id });
    expect(fakes.mails).toHaveLength(1);
    expect(fakes.mails[0]).toMatchObject({ to: email, kind: 'staff_invite' });
    expect((await row(email))!.email_verified).toBe(0);
  });

  it('return shape is identical across branches (only { userId })', async () => {
    const v = await seedUser();
    const a = await rpc().inviteChatMember({ email: v.email, firstName: 'X', workspaceName: WS });
    const b = await rpc().inviteChatMember({ email: mail(), firstName: 'X', workspaceName: WS });
    expect(Object.keys(a)).toEqual(['userId']);
    expect(Object.keys(b)).toEqual(['userId']);
  });

  it('inactive / suspended identity throws INVITE_REFUSED and mails nothing', async () => {
    const v = await seedUser();
    await env.DB.prepare(`UPDATE users SET status = 'suspended' WHERE id = ?1`).bind(v.id).run();
    await expect(
      rpc().inviteChatMember({ email: v.email, firstName: 'X', workspaceName: WS })
    ).rejects.toThrow('INVITE_REFUSED');
    expect(fakes.mails).toHaveLength(0);
    expect(fakes.notices).toHaveLength(0);
  });

  it('a soft-deleted (erased) identity throws INVITE_REFUSED and creates nothing', async () => {
    const v = await seedUser();
    await env.DB.prepare(`UPDATE users SET deleted_at = ?2 WHERE id = ?1`)
      .bind(v.id, new Date().toISOString())
      .run();
    await expect(
      rpc().inviteChatMember({ email: v.email, firstName: 'X', workspaceName: WS })
    ).rejects.toThrow('INVITE_REFUSED');
    expect(fakes.mails).toHaveLength(0);
  });

  it('mail is capped at 5 per address per hour, silently: the same id still comes back', async () => {
    const v = await seedUser();
    const ids: string[] = [];
    for (let i = 0; i < 7; i++)
      ids.push(
        (await rpc().inviteChatMember({ email: v.email, firstName: 'X', workspaceName: WS })).userId
      );
    expect(new Set(ids)).toEqual(new Set([v.id]));
    expect(fakes.notices).toHaveLength(5);
  });

  it('strips CR/LF and control characters from the workspace name before it reaches any mail', async () => {
    const email = mail();
    await rpc().inviteChatMember({
      email,
      firstName: 'X',
      workspaceName: 'Acme\r\nBcc: a@b.c\u0007',
    });
    expect(fakes.mails[0].storeName).toBe('Acme Bcc: a@b.c');
    await expect(
      rpc().inviteChatMember({ email: mail(), firstName: 'X', workspaceName: '\r\n\t' })
    ).rejects.toThrow();
  });

  it('validates input strictly (bad email, empty workspace, unknown field)', async () => {
    await expect(
      rpc().inviteChatMember({ email: 'nope', firstName: 'X', workspaceName: WS })
    ).rejects.toThrow();
    await expect(
      rpc().inviteChatMember({ email: mail(), firstName: 'X', workspaceName: ' ' })
    ).rejects.toThrow();
    await expect(
      rpc().inviteChatMember({
        email: mail(),
        firstName: 'X',
        workspaceName: WS,
        role: 'super_admin',
      } as never)
    ).rejects.toThrow();
    expect(fakes.mails).toHaveLength(0);
  });

  it('writes an audit line without the address or any code', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const email = mail();
      await rpc().inviteChatMember({ email, firstName: 'X', workspaceName: WS });
      const line = log.mock.calls
        .map(c => String(c[0]))
        .find(l => l.includes('chat_member_invited'));
      expect(line).toBeTruthy();
      expect(line).not.toContain(email);
      expect(line).not.toContain(fakes.mails[0].code);
    } finally {
      log.mockRestore();
    }
  });
});
