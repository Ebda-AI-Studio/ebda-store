import { z } from 'zod/v3';
import { toAsciiDigits } from '../ascii-digits';

/**
 * The ONE phone-format rule for every user-typed phone field (admin profile/staff/suppliers/locations, storefront
 * checkout/addresses/wholesale/affiliate). An optional leading `+`, then 7-15 digits once spaces, dashes, dots and
 * brackets are stripped (Eastern Arabic digits accepted). An e-mail, a name or a stray letter is NOT a phone (G12:
 * an e-mail was accepted as a new phone number because the input only had `type="tel"`, which never validates).
 */
const SEPARATORS = /[\s\-().‎‏‪-‮]/g;
const PHONE_BODY = /^\+?[0-9]{7,15}$/;

export function isPlausiblePhone(raw: string): boolean {
  return PHONE_BODY.test(toAsciiDigits(raw).replace(SEPARATORS, ''));
}

/** A required phone, trimmed. */
export const phoneSchema = z
  .string()
  .trim()
  .max(40)
  .refine(isPlausiblePhone, { message: 'Invalid phone number' });

/** An optional phone field where a blank means "none" (forms send '' for an empty box). */
export const phoneOrBlankSchema = z
  .string()
  .trim()
  .max(40)
  .refine(v => v === '' || isPlausiblePhone(v), { message: 'Invalid phone number' });
