import { z } from 'zod';
import { getLook, isBuiltLook, isBuiltSkin } from '@ebda/shared';
import { SIGNUP_PLAN_CODES } from '../services/billing/trial';

/** Body of POST /onboarding/store. Own file so the edge validation is unit-testable without Express. */
export const createStoreSchema = z.object({
  name: z.string().trim().min(1).max(100),
  nameAr: z.string().trim().min(1).max(100).optional(),
  slug: z.string().trim().min(1).max(60),
  /** A skin a BUILT look renders with (looks registry). The legacy Force skins are refused. */
  template: z
    .string()
    .refine(isBuiltSkin, { message: 'This template is not available for new stores' })
    .optional(),
  /** A look id from the shared registry; unknown ids are refused before anything is created. */
  lookId: z
    .string()
    .refine(id => getLook(id) !== undefined, { message: 'Unknown look' })
    .refine(id => isBuiltLook(id), { message: 'This look is not available for new stores' })
    .optional(),
  language: z.enum(['ar', 'en']).optional(),
  /** Referral link: the referrer's store slug (FOUNDING-1). Unknown or self slugs are ignored. */
  ref: z.string().trim().min(1).max(60).optional(),
  /** Plan chosen at signup (marketing deep link / plan step); billed at trial end. */
  plan: z
    .object({
      planCode: z.enum(SIGNUP_PLAN_CODES),
      interval: z.enum(['monthly', 'yearly']),
    })
    .strict()
    .optional(),
});
