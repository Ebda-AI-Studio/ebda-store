import { escapeLike, normalizeArabicSearch, searchTokens } from './arabic-normalize';
import { phoneSearchDigits } from './phone-search';

/** `%x%` LIKE patterns for the customer lookup (Postgres definer `ebda_customer_search_ids`, DO `searchCustomers`). */
export interface CustomerPatterns {
  names: string[];
  digits: string | null;
  email: string | null;
}

/**
 * Turn what an admin typed into the lookup's three arms:
 *  - names:  every Arabic-normalised token must be contained in the full name (AND);
 *  - digits: (only for a digits-and-punctuation term) the phone in any form (+20 / 0020 / 01x / Arabic-Indic digits), see `phoneSearchDigits`;
 *  - email:  a Latin/@ term with no whitespace, 3+ characters, ILIKE-matched against the email (E18-E20).
 * A token with no letter (digits, '+20') is a phone/order-number term, never a name, so it adds no name pattern.
 */
export function buildCustomerPatterns(q: string): CustomerPatterns {
  const raw = (q ?? '').trim().slice(0, 100);
  // A phone term holds only digits and phone punctuation: "a3f09b1c4e" is not a number just
  // because 4+ of its characters are digits (that would add a broad digits arm to every id search).
  const digits = /^[+\d\s\-().]+$/.test(normalizeArabicSearch(raw)) ? phoneSearchDigits(raw) : null;
  const tokens = searchTokens(raw);
  const names = tokens.filter(t => /\p{L}/u.test(t));
  return {
    names: names.map(t => `%${escapeLike(t)}%`),
    digits: digits ? `%${digits}%` : null,
    email:
      raw.length >= 3 && !/\s/.test(raw) && /[A-Za-z@]/.test(raw) ? `%${escapeLike(raw)}%` : null,
  };
}
