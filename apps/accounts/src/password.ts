import bcrypt from 'bcryptjs';
import { z } from 'zod/v3';
import { addPasswordPolicyIssues } from '../../../packages/shared/src/password-policy';

/** The ONE shared password policy (packages/shared/src/password-policy.ts), same as the Store register schema. */
export const passwordPolicy = z.string().max(200).superRefine(addPasswordPolicyIssues);

export const BCRYPT_COST = 12;

/**
 * A cost-12 hash of a value nobody can supply: compared against when the account does not exist, so a missing
 * account costs the same wall time as a wrong password (no stopwatch enumeration).
 */
// nosemgrep: generic.secrets.security.detected-bcrypt-hash.detected-bcrypt-hash -- dummy hash for timing equalisation (random plaintext discarded), not a credential
export const DUMMY_HASH = '$2b$12$fG8PP9O5RGPMiNPM8qnSGuf8W6QjNTyMUEITsE9qXgKBbrU9muUz2';

export const hashPassword = (pw: string): Promise<string> => bcrypt.hash(pw, BCRYPT_COST);

/** Legacy seed rows carry a `!seed-...` marker instead of a hash: they can never match. */
export async function verifyPassword(pw: string, hash: string): Promise<boolean> {
  if (!/^\$2[aby]\$\d{2}\$/.test(hash)) {
    await bcrypt.compare(pw, DUMMY_HASH);
    return false;
  }
  return bcrypt.compare(pw, hash);
}
