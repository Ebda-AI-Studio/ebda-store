import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { BRAND } from '@force/shared';

const ISSUER: string = BRAND.product.nameEn;

export class MfaService {
  static generateEnrollment(accountLabel: string): { secret: string; otpauthUrl: string } {
    const secret = authenticator.generateSecret();
    const otpauthUrl = authenticator.keyuri(accountLabel, ISSUER, secret);
    return { secret, otpauthUrl };
  }

  static async qrDataUrl(otpauthUrl: string): Promise<string> {
    return QRCode.toDataURL(otpauthUrl);
  }

  static verifyCode(secret: string, token: string): boolean {
    if (!/^\d{6}$/.test(token ?? '')) return false;
    return authenticator.verify({ token, secret, window: 1 } as any);
  }

  static async generateBackupCodes(count = 10): Promise<{ plain: string[]; hashed: string[] }> {
    const plain = Array.from({ length: count }, () => crypto.randomBytes(5).toString('hex'));
    const hashed = await Promise.all(plain.map(c => bcrypt.hash(c, 10)));
    return { plain, hashed };
  }

  static async consumeBackupCode(
    hashed: string[],
    candidate: string
  ): Promise<{ matched: boolean; remaining: string[] }> {
    for (let i = 0; i < hashed.length; i++) {
      if (await bcrypt.compare(candidate ?? '', hashed[i])) {
        return { matched: true, remaining: hashed.filter((_, idx) => idx !== i) };
      }
    }
    return { matched: false, remaining: hashed };
  }
}
