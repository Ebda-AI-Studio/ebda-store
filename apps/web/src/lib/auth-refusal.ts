import { passwordFailureSentence } from '@ebda/shared';
import { demoRefusalText } from './demo-refusal';

/**
 * The sentence a storefront auth form shows for a refusal it knows, in the shopper's language, or null for anything
 * else (the form keeps its own fallback). The API's own messages are English-only ("Too many requests, please try
 * again.", "Invalid email or password"), so an Arabic storefront must never print them (QA P2-10 / P2-3 class: the
 * throttled sign-in showed English, or nothing, inside the Arabic UI).
 */
const THROTTLE_CODES = new Set(['RATE_LIMITED', 'TOO_MANY_ATTEMPTS', 'ACCOUNT_LOCKED']);

/** The `password` / `newPassword` entries of a VALIDATION_ERROR's `details` (the API's zod handler also files two
 *  bilingual STRINGS beside the field arrays, so only arrays count). */
function passwordDetailMessages(details: unknown): unknown[] {
  if (!details || typeof details !== 'object') return [];
  const d = details as Record<string, unknown>;
  return [d.password, d.newPassword].flatMap(v => (Array.isArray(v) ? v : []));
}

export function authRefusalText(
  error: { code?: unknown; details?: unknown } | null | undefined,
  t: (en: string, ar: string) => string
): string | null {
  const demo = demoRefusalText(error, t);
  if (demo) return demo;
  const code = typeof error?.code === 'string' ? error.code : '';
  if (THROTTLE_CODES.has(code)) {
    return t(
      'Too many attempts. Please wait a few minutes, then try again.',
      'محاولات كتير. استنى كام دقيقة وجرّب تاني.'
    );
  }
  if (code === 'VALIDATION_ERROR') {
    // Name WHICH password rule failed instead of the generic "invalid data" (a shopper cannot fix what is not named).
    const messages = passwordDetailMessages(error?.details);
    const en = passwordFailureSentence(messages, 'en');
    const ar = passwordFailureSentence(messages, 'ar');
    if (en && ar) return t(en, ar);
  }
  if (code === 'INVALID_CREDENTIALS') {
    return t('The email or password is not right.', 'الإيميل أو كلمة المرور مش صح.');
  }
  return null;
}
