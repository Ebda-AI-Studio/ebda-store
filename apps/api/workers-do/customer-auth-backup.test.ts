// N-9 / Ruling NZ-N9-3: customer credentials ARE in the R2 backup, encrypted; a restore into an empty DO brings every customer back
// (login works, passkeys present), refresh / one-time tokens are not carried; a tampered file, a wrong key or a missing key fails.
import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { StoreDO } from '../src/cf/store-do/store-do';
import { backupKey, decryptBlob, encryptBlob } from '../src/cf/store-do/backup';

const e = env as unknown as {
  STORE_BACKUPS: R2Bucket;
  STORE_DO: DurableObjectNamespace<StoreDO>;
  CUSTOMER_AUTH_BACKUP_KEY: string;
};
// bcrypt cost 4 of 'Passw0rd!xyz' (fixture only)
const HASH = '$2b$04$jYDlZaJj/X/kmBmzPXDwsOP4.aIZ2IBm.rDUDGyiC8iKKUZPb/Rzm';
const stub = (n: string) => e.STORE_DO.get(e.STORE_DO.idFromName(n));
const op = async (n: string, store: string, o: string, args: Record<string, unknown>) => {
  const r = await stub(n).authOp(store, o, JSON.stringify(args));
  return r.ok ? JSON.parse(r.json) : r;
};
const day = () => new Date().toISOString().slice(0, 10);

describe('customer credentials in the backup', () => {
  it('encrypts, never stores plaintext, restores logins and passkeys, skips tokens', async () => {
    const S = 'cab-src';
    await op(S, S, 'register', {
      id: 'u1',
      email: 'a@x.com',
      passwordHash: HASH,
      firstName: 'A',
      lastName: 'B',
      verification: { tokenHash: 'v'.repeat(64), expiresAt: Date.now() + 1e9, rowId: 'v1' },
    });
    await op(S, S, 'issueSession', {
      userId: 'u1',
      expectedTv: 0,
      tokenHash: 'r'.repeat(64),
      rowId: 'r1',
      expiresAt: Date.now() + 1e9,
    });
    await op(S, S, 'passkeyAdd', {
      id: 'p1',
      userId: 'u1',
      credentialId: 'cred-1',
      publicKey: 'pk',
      counter: 3,
      transports: [],
      deviceType: 'singleDevice',
      backedUp: false,
      rpId: 'x',
      name: 'n',
    });
    const manifest = await runInDurableObject(stub(S), (d: StoreDO) => d.backupNow(S));
    expect(manifest.customerAuth).toMatchObject({
      users: 1,
      passkeys: 1,
      file: 'customer-auth.enc',
    });

    const blob = await (await e.STORE_BACKUPS.get(
      backupKey(S, day(), 'customer-auth.enc')
    ))!.text();
    expect(blob).not.toContain('a@x.com');
    expect(blob).not.toContain(HASH);
    // no plaintext credential file anywhere in the backup
    const listed = await e.STORE_BACKUPS.list({ prefix: `store-do-backups/${S}/` });
    for (const o of listed.objects) expect(o.key).not.toMatch(/_cauth/);

    const T = 'cab-target';
    const res = await stub(T).restoreFrom(S, day());
    expect(res.ok).toBe(true);
    // the restored DO serves the customer: the credential is back (the Worker's bcrypt compare then logs them in), passkey present, the session token did NOT come back
    expect(await op(T, S, 'credential', { email: 'a@x.com' })).toMatchObject({
      id: 'u1',
      hash: HASH,
    });
    expect(await op(T, S, 'passkeyLookup', { credentialId: 'cred-1' })).toMatchObject({
      passkey: { counter: 3 },
    });
    expect(
      await op(T, S, 'rotateRefresh', {
        presentedHash: 'r'.repeat(64),
        newHash: 'n'.repeat(64),
        newRowId: 'n1',
        newExpiresAt: Date.now() + 1e9,
      })
    ).toMatchObject({ code: 'TOKEN_INVALID' });
  });

  it('a wrong key, a tampered blob and a missing key fail; a store without customers needs no key', async () => {
    const good = await encryptBlob(e.CUSTOMER_AUTH_BACKUP_KEY, 'secret');
    expect(await decryptBlob(e.CUSTOMER_AUTH_BACKUP_KEY, good)).toBe('secret');
    const other = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
    await expect(decryptBlob(other, good)).rejects.toThrow();
    const [iv, ct] = good.split('.');
    await expect(
      decryptBlob(e.CUSTOMER_AUTH_BACKUP_KEY, `${iv}.${ct.slice(0, -4)}AAAA`)
    ).rejects.toThrow();
    await expect(encryptBlob(undefined, 'x')).rejects.toThrow(/32 bytes/);
    // no customers -> no customer-auth file, backup still works with the key irrelevant
    const E = 'cab-empty';
    const m = await runInDurableObject(stub(E), (d: StoreDO) => d.backupNow(E));
    expect(m.customerAuth).toBeUndefined();
  });
});
