/**
 * `wa.me` click-to-chat helpers — the FREE WhatsApp tier (SP8).
 *
 * A `wa.me` link only OPENS a chat with text prefilled; nothing is sent until
 * the person presses send. There is no WhatsApp API, no webhook and no
 * delivery tracking here — the paid "Ebda Chat platform" (Cloud API) is a
 * separate tier. Pure functions only: no I/O, no `fetch`.
 */

import { normalizeEgyptianMobile } from '../region';

/** Max characters of prefilled text kept before the guard trims it. */
export const WA_ME_MAX_TEXT_CHARS = 1000;
/** Max length of the URL-encoded text (Arabic is ~6 bytes/char once encoded). */
export const WA_ME_MAX_ENCODED_LENGTH = 3500;

/**
 * Egyptian mobile → digits-only international form (`20XXXXXXXXXX`) as
 * `wa.me` requires (no `+`, no spaces). `null` when missing/invalid.
 */
export function waMeNumber(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const e164 = normalizeEgyptianMobile(phone);
  return e164 ? e164.replace(/^\+/, '') : null;
}

/**
 * Trim `text` so its URL-encoded form stays within both guards, cutting on a
 * code-point boundary (never splits an emoji / surrogate pair) and marking the
 * cut with an ellipsis.
 */
export function clampWaText(
  text: string,
  maxChars: number = WA_ME_MAX_TEXT_CHARS,
  maxEncoded: number = WA_ME_MAX_ENCODED_LENGTH
): string {
  const chars = Array.from(text.trim());
  if (chars.length <= maxChars && encodeURIComponent(chars.join('')).length <= maxEncoded) {
    return chars.join('');
  }
  let keep = Math.min(chars.length, maxChars) - 1;
  while (keep > 0 && encodeURIComponent(chars.slice(0, keep).join('') + '…').length > maxEncoded) {
    keep = Math.floor(keep * 0.9);
  }
  return chars.slice(0, Math.max(keep, 0)).join('').trimEnd() + '…';
}

/**
 * `https://wa.me/20XXXXXXXXXX?text=…` for a chat with `phone`.
 * Returns `null` when the number is missing or not a valid Egyptian mobile —
 * the caller then HIDES the button rather than rendering a dead link.
 */
export function waMeLink(phone: string | null | undefined, text?: string): string | null {
  const digits = waMeNumber(phone);
  if (!digits) return null;
  const body = text ? clampWaText(text) : '';
  return body
    ? `https://wa.me/${digits}?text=${encodeURIComponent(body)}`
    : `https://wa.me/${digits}`;
}

/** `https://wa.me/?text=…` — the person picks the recipient (share flows). */
export function waMeShareLink(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(clampWaText(text))}`;
}

/** True when `phone` can produce a wa.me link (drives show/hide of buttons). */
export function hasWaMeNumber(phone: string | null | undefined): boolean {
  return waMeNumber(phone) !== null;
}

// ─── Merchant toggles ────────────────────────────────────────────────────────

/** The three per-store toggles. Stored on StoreTheme; unset means ON. */
export interface WaMeToggles {
  waMeProductShare?: boolean;
  waMeOrderQuestion?: boolean;
  waMeCodConfirm?: boolean;
}

export interface WaMeVisibility {
  /** Store has a valid number — gate for every button. */
  hasNumber: boolean;
  productShare: boolean;
  orderQuestion: boolean;
  codConfirm: boolean;
}

/** Toggles default ON where a valid number exists; always OFF without one. */
export function resolveWaMeVisibility(
  phone: string | null | undefined,
  toggles?: WaMeToggles | null
): WaMeVisibility {
  const hasNumber = hasWaMeNumber(phone);
  return {
    hasNumber,
    productShare: hasNumber && toggles?.waMeProductShare !== false,
    orderQuestion: hasNumber && toggles?.waMeOrderQuestion !== false,
    codConfirm: hasNumber && toggles?.waMeCodConfirm !== false,
  };
}
