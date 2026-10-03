/**
 * Self-serve merchant signup (SP5 task 2).
 *
 * A visitor with no store and no human on our side creates a `store_admin`
 * account (unverified), verifies the email, and only THEN may create a store
 * (see onboarding.routes.ts `requireVerifiedEmail`).
 *
 * The public response is identical for a new and an already-registered
 * address (`{ emailVerificationSent: true }`): no account enumeration through
 * status, body shape, or - because bcrypt always runs - timing. The rightful
 * owner of an existing address gets a "you already have an account" mail.
 */
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma, withUser } from '@force/database';
import { normalizeEgyptianMobile } from '@force/shared';
import logger from '../lib/logger';
import { maskEmail } from '../lib/pii-mask';
import { ensureAdminUser, findUserIdByEmail } from '../lib/definer';
import { AuthService } from './auth.service';
import { sendMerchantDuplicateSignupNotice } from './platform-mailer';

/** Same password policy as `/auth/register`. */
const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128)
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number')
  .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character');

export const merchantSignupSchema = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email address').max(254),
  password: passwordSchema,
  name: z.string().trim().min(1, 'Name is required').max(100),
  /** Optional. Must be a valid Egyptian mobile; stored as E.164. */
  phone: z
    .string()
    .trim()
    .max(32)
    .optional()
    .transform(v => (v ? v : undefined))
    .refine(v => v === undefined || normalizeEgyptianMobile(v) !== null, {
      message: 'Invalid Egyptian mobile number',
    }),
  language: z.enum(['ar', 'en']).optional(),
  /**
   * Abuse controls (services/signup-abuse.service.ts): the hidden honeypot
   * input (must stay empty) and the server-signed form token from
   * `GET /auth/merchant/signup-token`. Both optional HERE so the schema stays
   * the account shape; the route enforces them.
   */
  company_site: z.string().max(500).optional(),
  formToken: z.string().max(200).optional(),
});

export type MerchantSignupInput = z.infer<typeof merchantSignupSchema>;

export const GENERIC_SIGNUP_RESULT = { emailVerificationSent: true } as const;

/** One verification mail per address per minute from the resend route. */
const RESEND_COOLDOWN_MS = 60 * 1000;

const SALT_ROUNDS = 12;

// Hash of random bytes, computed once: the unknown-address resend path and the
// existing-address signup path both spend a bcrypt so timing is uniform.
const DUMMY_HASH = bcrypt.hashSync(`dummy-${Math.random()}-${Date.now()}`, SALT_ROUNDS);

export class MerchantSignupService {
  static async signup(input: MerchantSignupInput): Promise<typeof GENERIC_SIGNUP_RESULT> {
    const { email, name, language } = input;
    const phone = input.phone ? normalizeEgyptianMobile(input.phone) : null;

    // Always hash, even when the address is taken (timing parity).
    const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);

    // Nobody is signed in, and the admin namespace (users.store_id NULL) is not
    // visible from any scope: the id comes from the `ebda_auth_find_user_id`
    // definer (case-insensitive, id only) and the row is read AS that user.
    const existingId = await findUserIdByEmail(email, null, { caseInsensitive: true });
    const existing = existingId
      ? await withUser(existingId, tx =>
          tx.user.findUnique({
            where: { id: existingId },
            select: { id: true, email: true, firstName: true, role: true, emailVerified: true },
          })
        )
      : null;

    if (existing && existing.role === 'store_admin' && !existing.emailVerified) {
      // Signed up before but never verified (lost mail): treat as a resend.
      return this.resendVerification(existing.email);
    }

    if (existing) {
      await sendMerchantDuplicateSignupNotice(
        { email: existing.email, name: existing.firstName || existing.email },
        language
      ).catch(err =>
        logger.error({ err, email: maskEmail(email) }, 'merchant duplicate-signup notice failed')
      );
      return GENERIC_SIGNUP_RESULT;
    }

    const parts = name.split(/\s+/);
    // Find-or-create through the `ebda_admin_user_ensure` definer (it can only
    // mint a store_admin or staff account). `created: false` means another signup
    // for the same address won the race: indistinguishable from "taken".
    const created = await ensureAdminUser({
      email,
      passwordHash,
      firstName: parts[0],
      lastName: parts.slice(1).join(' '),
      role: 'store_admin',
      emailVerified: false,
    });
    if (!created.created) return GENERIC_SIGNUP_RESULT;
    // Phone and language are not part of the definer's contract: set them as the
    // new user (its own row, under its own user scope).
    await withUser(created.id, tx =>
      tx.user.update({
        where: { id: created.id },
        data: { phone, language: language ?? 'ar' },
      })
    );
    const user = {
      id: created.id,
      email: created.email,
      firstName: created.firstName,
      lastName: created.lastName,
    };

    await AuthService.sendVerificationEmail(
      user.id,
      user.email,
      `${user.firstName} ${user.lastName}`.trim() || user.email,
      null,
      language
    ).catch(err =>
      // The account exists; the user can use "resend". Never fail the response.
      logger.error({ err, userId: user.id }, 'merchant verification mail failed after signup')
    );

    return GENERIC_SIGNUP_RESULT;
  }

  /**
   * Resend the verification mail. Always answers generically; sends only for an
   * existing, still-unverified merchant account with no mail in the last minute.
   */
  static async resendVerification(email: string): Promise<typeof GENERIC_SIGNUP_RESULT> {
    const userId = await findUserIdByEmail(email, null, { caseInsensitive: true });
    const found = userId
      ? await withUser(userId, tx =>
          tx.user.findUnique({
            where: { id: userId },
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
              emailVerified: true,
              language: true,
              role: true,
            },
          })
        )
      : null;
    const user = found?.role === 'store_admin' ? found : null;

    if (!user || user.emailVerified) {
      await bcrypt.compare('x', DUMMY_HASH);
      return GENERIC_SIGNUP_RESULT;
    }

    const recent = await prisma.verificationToken.findFirst({
      where: {
        userId: user.id,
        type: 'email',
        createdAt: { gt: new Date(Date.now() - RESEND_COOLDOWN_MS) },
      },
      select: { id: true },
    });
    if (recent) return GENERIC_SIGNUP_RESULT;

    await AuthService.sendVerificationEmail(
      user.id,
      user.email,
      `${user.firstName} ${user.lastName}`.trim() || user.email,
      null,
      (user.language as 'ar' | 'en' | undefined) ?? undefined
    ).catch(err => logger.error({ err, userId: user.id }, 'merchant resend verification failed'));

    return GENERIC_SIGNUP_RESULT;
  }
}
