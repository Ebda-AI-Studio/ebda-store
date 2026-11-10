import { demoRefusalText } from './demo-refusal';

/**
 * The sentence a storefront auth form shows for a refusal it knows, in the shopper's language, or null for anything
 * else (the form keeps its own fallback). The API's own messages are English-only ("Too many requests, please try
 * again.", "Invalid email or password"), so an Arabic storefront must never print them (QA P2-10 / P2-3 class: the
 * throttled sign-in showed English, or nothing, inside the Arabic UI).
 */
const THROTTLE_CODES = new Set(['RATE_LIMITED', 'TOO_MANY_ATTEMPTS', 'ACCOUNT_LOCKED']);

export function authRefusalText(
  error: { code?: unknown } | null | undefined,
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
  if (code === 'INVALID_CREDENTIALS') {
    return t('The email or password is not right.', 'الإيميل أو كلمة المرور مش صح.');
  }
  return null;
}
