import { describe, it, expect } from 'vitest';
import { MfaService } from '@api/services/mfa.service';
import { authenticator } from 'otplib';

describe('MfaService', () => {
  it('generates a secret and an otpauth url for the account', () => {
    const { secret, otpauthUrl } = MfaService.generateEnrollment('admin@store.test');
    expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
    expect(otpauthUrl).toContain('otpauth://totp/');
    expect(otpauthUrl).toContain('admin%40store.test');
  });
  it('verifies a code produced from the secret', () => {
    const { secret } = MfaService.generateEnrollment('a@b.test');
    const code = authenticator.generate(secret);
    expect(MfaService.verifyCode(secret, code)).toBe(true);
    expect(MfaService.verifyCode(secret, '000000')).toBe(false);
  });
  it('generates 10 backup codes and verifies one-time consumption', async () => {
    const { plain, hashed } = await MfaService.generateBackupCodes();
    expect(plain).toHaveLength(10);
    expect(hashed).toHaveLength(10);
    const { matched, remaining } = await MfaService.consumeBackupCode(hashed, plain[3]);
    expect(matched).toBe(true);
    expect(remaining).toHaveLength(9);
    const again = await MfaService.consumeBackupCode(remaining, plain[3]);
    expect(again.matched).toBe(false);
  });
});
