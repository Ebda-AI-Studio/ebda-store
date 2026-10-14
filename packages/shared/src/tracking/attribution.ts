/**
 * First-touch acquisition attribution: utm_* and fbclid, captured on the first landing and
 * kept in a first-party cookie for 90 days, then forwarded with the signup request.
 */

export const EBDA_ATTRIBUTION_COOKIE = 'ebda_attr';
export const EBDA_ATTRIBUTION_MAX_AGE_DAYS = 90;
export const META_FBC_COOKIE = '_fbc';
export const META_FBP_COOKIE = '_fbp';

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;
export type UtmKey = (typeof UTM_KEYS)[number];

const MAX_VALUE_LENGTH = 200;

export interface EbdaAttribution {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  fbclid?: string;
  /** Meta click id in the cookie format: fb.1.<ms>.<fbclid>. */
  fbc?: string;
  /** Landing path (no query string) of the first touch. */
  landing?: string;
  /** Referrer host of the first touch ('' / absent = direct). */
  referrer?: string;
  /** First-touch time, ms since epoch. */
  first_seen: number;
}

/** Trim, drop control characters, cap the length. Empty -> undefined. */
export function cleanValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return v ? v.slice(0, MAX_VALUE_LENGTH) : undefined;
}

/** Meta's `_fbc` cookie format. subdomainIndex 1 = the registrable domain (ebda.app). */
export function buildFbc(fbclid: string, createdAtMs: number): string {
  return `fb.1.${Math.floor(createdAtMs)}.${fbclid}`;
}

function hasPaidSignal(a: EbdaAttribution | null): boolean {
  return !!a && (!!a.utm_source || !!a.fbclid);
}

export interface CaptureInput {
  /** `window.location.search`. */
  search: string;
  /** `window.location.pathname`. */
  pathname: string;
  /** `document.referrer`. */
  referrer?: string;
  now: number;
  existing: EbdaAttribution | null;
}

function referrerHost(referrer: string | undefined): string | undefined {
  if (!referrer) return undefined;
  try {
    return new URL(referrer).hostname.slice(0, MAX_VALUE_LENGTH) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fold the current landing into the stored attribution.
 *  - No record yet: this visit is the first touch (organic visits are recorded too).
 *  - A record that has no utm/fbclid, and this URL carries one: the ad click is the truer
 *    source, so it replaces the organic record (first PAID touch wins).
 *  - Otherwise the first touch is kept, except a NEW fbclid always refreshes fbclid/fbc
 *    (Meta matches on the latest click).
 * Returns the record to store, or null when nothing changed.
 */
export function captureAttribution(input: CaptureInput): EbdaAttribution | null {
  const params = new URLSearchParams(input.search);
  const fresh: Partial<EbdaAttribution> = {};
  for (const key of UTM_KEYS) {
    const v = cleanValue(params.get(key));
    if (v) fresh[key] = v;
  }
  const fbclid = cleanValue(params.get('fbclid'));
  if (fbclid) {
    fresh.fbclid = fbclid;
    fresh.fbc = buildFbc(fbclid, input.now);
  }
  const freshIsPaid = !!fresh.utm_source || !!fresh.fbclid;
  const { existing } = input;

  if (!existing || (!hasPaidSignal(existing) && freshIsPaid)) {
    return {
      ...fresh,
      landing: cleanValue(input.pathname),
      referrer: referrerHost(input.referrer),
      first_seen: input.now,
    };
  }
  if (fresh.fbclid && fresh.fbclid !== existing.fbclid) {
    return { ...existing, fbclid: fresh.fbclid, fbc: fresh.fbc };
  }
  return null;
}

export function serializeAttribution(a: EbdaAttribution): string {
  return encodeURIComponent(JSON.stringify(a));
}

/** Parse + re-sanitise a stored cookie (it is user-controlled input). */
export function parseAttribution(raw: string | null | undefined): EbdaAttribution | null {
  if (!raw) return null;
  try {
    return sanitizeAttribution(JSON.parse(decodeURIComponent(raw)));
  } catch {
    return null;
  }
}

/** Whitelist + length-cap any attribution-shaped object. Null when it is not one. */
export function sanitizeAttribution(input: unknown): EbdaAttribution | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const firstSeen =
    typeof o.first_seen === 'number' && Number.isFinite(o.first_seen) ? o.first_seen : null;
  if (firstSeen === null) return null;
  const out: EbdaAttribution = { first_seen: firstSeen };
  for (const key of [...UTM_KEYS, 'fbclid', 'fbc', 'landing', 'referrer'] as const) {
    const v = cleanValue(o[key]);
    if (v) out[key] = v;
  }
  return out;
}
