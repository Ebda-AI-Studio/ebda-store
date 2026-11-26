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
import { z } from 'zod/v3';
import { withUser, type Prisma } from '@ebda/database';
import { postgresRemovedOnThisWorker } from '../lib/postgres-present';
import { addPasswordPolicyIssues, normalizeEgyptianMobile } from '@ebda/shared';
import logger from '../lib/logger';
import { maskEmail } from '../lib/pii-mask';
import { findUserIdByEmail } from '../lib/definer';
import {
  createIdentity,
  getAccountState,
  resendIdentityVerification,
} from '../lib/identity-client';
import { sendMerchantDuplicateSignupNotice } from './platform-mailer';
import { buildAcquisition, signupTrackingSchema } from './ebda-ads.service';
import { signupAcceptanceRows } from './legal-notice.service';

/** Same password policy as `/auth/register` (also used by `/auth/reset-password`). */
export const passwordSchema = z.string().max(128).superRefine(addPasswordPolicyIssues);

export const merchantSignupSchema = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email address').max(254),
  password: passwordSchema,
  name: z.string().trim().min(1, 'Name is required').max(100),
  /** Required Egyptian mobile; stored as E.164. */
  phone: z
    .string()
    .trim()
    .max(32)
    .min(1, 'Mobile number is required')
    .refine(v => normalizeEgyptianMobile(v) !== null, {
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
  /**
   * Ebda's own acquisition tracking (utm/fbclid/Meta ids + the consent the visitor gave).
   * Sent by the form only when the visitor allowed tracking; stored on `users.acquisition`.
   */
  tracking: signupTrackingSchema.optional(),
  /**
   * Click-wrap (Ruling LEGAL-4): the visitor ticked the box agreeing to all five documents
   * (Terms of service, Privacy policy, Merchant agreement, Acceptable use policy, Legal notice);
   * one acceptance row is recorded per document. Required: a signup without it is refused.
   */
  acceptedLegal: z.literal(true, {
    errorMap: () => ({ message: 'You must accept the terms and policies to create an account' }),
  }),
});

export type MerchantSignupInput = z.infer<typeof merchantSignupSchema>;

export const GENERIC_SIGNUP_RESULT = { emailVerificationSent: true } as const;

const SALT_ROUNDS = 12;

// Cost-12 hash of random bytes (plaintext discarded), a constant: the unknown-address
// resend path and the existing-address signup path both spend a bcrypt so timing is
// uniform. Not computed at import: bcrypt needs random bytes, which workerd forbids in
// global scope (R-EBDA-001).
// nosemgrep: generic.secrets.security.detected-bcrypt-hash.detected-bcrypt-hash -- dummy hash for timing equalisation (random plaintext discarded), not a credential
const DUMMY_HASH = '$2b$12$OW.xBchkmJbVjXDhBSQ6ke4cdbV/iuOcgjbbGK9ZslpcF5fkkynha';

/** Same address, unverified in the identity service, and no Store profile row under that id. */
async function isAdoptableOrphan(identityId: string, email: string): Promise<boolean> {
  const acc = await getAccountState(identityId).catch(() => null);
  if (!acc || acc.emailVerified || acc.email.trim().toLowerCase() !== email.trim().toLowerCase())
    return false;
  // NZ-D23: no Postgres profile table on the Worker, so no profile row can exist under this id.
  if (postgresRemovedOnThisWorker()) return true;
  const profile = await withUser(identityId, tx =>
    tx.user.findUnique({ where: { id: identityId }, select: { id: true } })
  );
  return !profile;
}

export class MerchantSignupService {
  static async signup(
    input: MerchantSignupInput,
    request: { ip?: string; userAgent?: string } = {}
  ): Promise<typeof GENERIC_SIGNUP_RESULT> {
    const { email, name, language } = input;
    const phone = input.phone ? normalizeEgyptianMobile(input.phone) : null;

    // Always spend a bcrypt, even when the address is taken (timing parity): the real hash is made by the identity service.
    await bcrypt.hash(input.password, SALT_ROUNDS);

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

    if (existing && existing.emailVerified) {
      await sendMerchantDuplicateSignupNotice(
        { email: existing.email, name: existing.firstName || existing.email },
        language
      ).catch(err =>
        logger.error({ err, email: maskEmail(email) }, 'merchant duplicate-signup notice failed')
      );
      return GENERIC_SIGNUP_RESULT;
    }

    // The credential now lives in the shared identity service (Ruling ID-1): it hashes the password, binds it to the
    // verification code it mails, and never overwrites an existing row's credential. A signup over a still-unverified
    // address re-registers it (the newest code carries the newest password).
    const parts = name.split(/\s+/);
    const firstName = parts[0];
    const lastName = parts.slice(1).join(' ');
    // The id is OURS: generated here (or the existing profile's), sent to the identity service, and the answer must be exactly it.
    // The profile row and the legal acceptances are only ever written under an id this function chose (Ruling SIGNUP-TAKEOVER-1),
    // so a wrong, replayed or attacker-influenced answer cannot bind a Store profile to someone else's identity.
    const requestedId = existing?.id ?? crypto.randomUUID();
    const identity = await createIdentity({
      id: requestedId,
      email,
      password: input.password,
      firstName,
      lastName,
      phone: phone ?? undefined,
      language: language ?? 'ar',
    });
    if (!identity) return GENERIC_SIGNUP_RESULT; // verified by someone else in the meantime: indistinguishable from "taken"
    let profileId = requestedId;
    if (identity.id !== requestedId) {
      // The identity service already holds this address under another id. That is legitimate in exactly one case, an ORPHAN
      // from a half-finished earlier signup: no Store profile for this address (existing is null), the identity is for the
      // SAME address, still unverified, and no profile row exists under its id. Then the merchant adopts it (otherwise they
      // would be stuck forever). Anything else writes nothing, logs an error and answers the same generic result.
      const adopt = !existing && (await isAdoptableOrphan(identity.id, email));
      if (!adopt) {
        logger.error(
          { email: maskEmail(email), requestedId, returnedId: identity.id },
          'merchant signup: identity id does not match the requested id; no profile written'
        );
        return GENERIC_SIGNUP_RESULT;
      }
      logger.warn(
        { email: maskEmail(email), adoptedId: identity.id },
        'merchant signup: adopting the id of an orphan unverified identity'
      );
      profileId = identity.id;
    }
    if (existing) return GENERIC_SIGNUP_RESULT; // unverified: the profile row and the acceptance rows already stand

    // Profile row (same id as the identity, so every foreign key resolves) + click-wrap acceptance in ONE transaction, as
    // the new user (Ruling LEGAL-4). Credentials are NOT stored here.
    const acquisition = buildAcquisition(input.tracking, request);
    // NZ-D23: on a Worker with no Postgres the identity service IS the account (no `users` profile row to write; the
    // acceptances live on the platform D1, where no FK needs the row). A Prisma call here throws POSTGRES_REMOVED (500).
    const pgGone = postgresRemovedOnThisWorker();
    await withUser(profileId, async tx => {
      if (!pgGone)
        await tx.user.create({
          data: {
            id: profileId,
            storeId: null,
            email,
            passwordHash: '!identity',
            firstName,
            lastName,
            phone,
            role: 'store_admin',
            emailVerified: false,
            language: language ?? 'ar',
            ...(acquisition
              ? { acquisition: acquisition as unknown as Prisma.InputJsonValue }
              : {}),
          },
        });
      await tx.legalAcceptance.createMany({
        data: signupAcceptanceRows(profileId, request),
        skipDuplicates: true,
      });
    });

    return GENERIC_SIGNUP_RESULT;
  }

  /**
   * Resend the verification mail. Always answers generically; sends only for an
   * existing, still-unverified merchant account with no mail in the last minute.
   */
  static async resendVerification(email: string): Promise<typeof GENERIC_SIGNUP_RESULT> {
    // The identity service owns verification codes (and their throttles); it answers nothing for an unknown or verified address.
    await bcrypt.compare('x', DUMMY_HASH); // uniform cost with the signup paths
    await resendIdentityVerification(email).catch(err =>
      logger.error({ err, email: maskEmail(email) }, 'merchant resend verification failed')
    );
    return GENERIC_SIGNUP_RESULT;
  }
}
