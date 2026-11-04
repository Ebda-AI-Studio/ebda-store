/**
 * ERROR_AR / ERROR_EN: the fallback text for an API error code (UX:C-1, BE:E-2 client side).
 *
 * `apiRequest` applies it, so no page edits `error.message` by hand. Order of precedence, decided in
 * `resolveErrorMessage`: (1) the server's own `details.messageAr/messageEn` (done by `localizedApiMessage`
 * before this runs), (2) server text that is already Arabic in an Arabic UI, (3) this map by `error.code`,
 * (4) this map by HTTP status class. English server text is NEVER shown in the Arabic UI.
 */

export type ErrorLocale = 'ar' | 'en';

export const ERROR_AR: Record<string, string> = {
  RATE_LIMITED: 'بتعمل طلبات كتير ورا بعض. استنى دقيقة وجرّب تاني.',
  NETWORK_ERROR: 'مفيش اتصال بالنت دلوقتي. اتأكد من الاتصال وجرّب تاني.',
  PARSE_ERROR: 'السيرفر رد برد مش مفهوم. جرّب تاني بعد شوية.',
  VALIDATION_ERROR: 'فيه بيانات ناقصة أو غلط. راجع الخانات وجرّب تاني.',
  NOT_FOUND: 'مش لاقيين اللي بتدوّر عليه. ممكن يكون اتمسح أو اتنقل.',
  FORBIDDEN: 'مش مسموحلك تعمل ده. كلّم صاحب المتجر لو محتاج الصلاحية.',
  SERVER_ERROR: 'حصلت مشكلة عندنا. جرّب تاني بعد شوية.',
  UNAUTHORIZED: 'الجلسة خلصت. سجّل دخول تاني وكمّل.',
  CONFLICT: 'فيه حاجة تانية بنفس البيانات دي. غيّر اللي كتبته وجرّب تاني.',
};

export const ERROR_EN: Record<string, string> = {
  RATE_LIMITED: 'Too many requests in a row. Wait a minute and try again.',
  NETWORK_ERROR: 'No connection right now. Check your internet and try again.',
  PARSE_ERROR: 'The server sent a reply we could not read. Try again in a moment.',
  VALIDATION_ERROR: 'Some details are missing or wrong. Check the fields and try again.',
  NOT_FOUND: 'We could not find what you were looking for. It may have been deleted or moved.',
  FORBIDDEN: 'You are not allowed to do this. Ask the store owner for access.',
  SERVER_ERROR: 'Something went wrong on our side. Try again in a moment.',
  UNAUTHORIZED: 'Your session ended. Sign in again to continue.',
  CONFLICT: 'Something with these details already exists. Change them and try again.',
};

const ARABIC_LETTERS = /[؀-ۿ]/;

/** The generic code for an HTTP status when the API sent no code of its own. */
export function codeForStatus(status: number): string | null {
  if (status === 0) return 'NETWORK_ERROR';
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 422) return 'VALIDATION_ERROR';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'SERVER_ERROR';
  return null;
}

/**
 * The message a merchant should see. `serverMessage` is whatever the API (or the localizer) produced;
 * `hasBilingualDetails` is true when it came from `details.messageAr/messageEn` and must win.
 */
export function resolveErrorMessage(args: {
  code: string | undefined;
  status: number;
  serverMessage: string;
  locale: ErrorLocale;
  hasBilingualDetails?: boolean;
}): string {
  const { code, status, serverMessage, locale, hasBilingualDetails } = args;
  if (hasBilingualDetails) return serverMessage;
  if (locale === 'ar' && ARABIC_LETTERS.test(serverMessage)) return serverMessage;
  const table = locale === 'ar' ? ERROR_AR : ERROR_EN;
  const key = code && table[code] ? code : codeForStatus(status);
  if (key && table[key]) {
    // English locale keeps specific server text; only the codes whose server text is a developer string are replaced.
    if (locale === 'en' && !['NETWORK_ERROR', 'PARSE_ERROR'].includes(key) && serverMessage) {
      return serverMessage;
    }
    return table[key];
  }
  return serverMessage;
}
