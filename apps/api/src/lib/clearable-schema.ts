import { z } from 'zod/v3';
import { isSafeUrl } from '@ebda/shared';

// CLEARABLE variants (STORE-QA-60). `optionalStr`/`optionalUrl` fold '' and null into `undefined`, and `undefined` in a Prisma
// update means "leave the column alone" - so a merchant who emptied a SEO title or removed a logo got a 200 and the old value
// stayed. For a nullable column the schema must keep "not sent" (undefined = no change) apart from "sent empty" (null = clear).
export const clearableStr = (maxLen: number) =>
  z.preprocess(
    v => (typeof v === 'string' ? (v.trim() === '' ? null : v) : v),
    z.string().max(maxLen).nullable().optional()
  );
export const clearableUrl = z.preprocess(
  v => (typeof v === 'string' ? (v.trim() === '' ? null : v) : v),
  z.string().url().max(500).nullable().optional()
);
export const clearableEmail = z.preprocess(
  v => (typeof v === 'string' ? (v.trim() === '' ? null : v) : v),
  z.string().email().max(255).nullable().optional()
);
export const clearableSafeUrl = z.preprocess(
  v => (typeof v === 'string' ? (v.trim() === '' ? null : v) : v),
  z
    .string()
    .max(500)
    .refine(isSafeUrl, {
      message:
        'Link must be a relative path or use http(s)/mailto/tel — javascript: is not allowed',
    })
    .nullable()
    .optional()
);
