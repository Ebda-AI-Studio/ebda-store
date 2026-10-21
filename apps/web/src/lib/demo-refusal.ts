import { translations } from '../contexts/LanguageContext';

/** What the visitor reads when the demo showroom refuses a write (403 `DEMO_STORE`, Ruling B1-13). */
const DEMO_REFUSAL_EN = 'This is a demo store: this is turned off here';

/**
 * The demo refusal in the visitor's language, or null when `error` is any other failure (the form
 * then keeps its own message). One sentence for every refused form: register, newsletter, contact,
 * affiliate apply.
 */
export function demoRefusalText(
  error: { code?: unknown } | null | undefined,
  t: (en: string, ar: string) => string
): string | null {
  return error?.code === 'DEMO_STORE' ? t(DEMO_REFUSAL_EN, translations[DEMO_REFUSAL_EN]) : null;
}
