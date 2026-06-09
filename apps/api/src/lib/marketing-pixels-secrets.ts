/**
 * Marketing-pixel secret handling.
 *
 * `store.marketingPixels` is a JSON blob keyed by platform. Two platforms carry
 * a long-lived server-side secret in addition to their public pixel ID:
 *   - `meta.accessToken`   — Meta Conversions API (CAPI) token
 *   - `tiktok.accessToken` — TikTok Events API token
 *
 * These tokens are NOT needed by the browser (the client-side pixel snippets
 * only use the public pixel ID). They must therefore never be returned to a
 * storefront visitor, and in the admin they must be masked so a token can't be
 * shoulder-surfed / lifted from devtools or a network proxy.
 *
 * Mask sentinel: a masked value always contains `****` (see `encryption.mask`).
 * On save, if the incoming token still contains `****` we treat it as
 * "unchanged" and preserve the stored value instead of overwriting the real
 * secret with mask text.
 */

import { encryption } from '../services/encryption.service';

// Per-platform fields that hold a secret (vs. a public pixel ID).
const SECRET_FIELDS = ['accessToken'] as const;

type PixelRecord = Record<string, Record<string, unknown> | undefined>;

const MASK_SENTINEL = '****';

function isMasked(value: unknown): boolean {
  return typeof value === 'string' && value.includes(MASK_SENTINEL);
}

/**
 * Return a copy of `pixels` with every secret field masked for safe display in
 * the admin (e.g. `EAAB****wXyz`). Public pixel IDs are left untouched.
 */
export function maskMarketingPixelSecrets(pixels: unknown): unknown {
  if (!pixels || typeof pixels !== 'object') return pixels;
  const src = pixels as PixelRecord;
  const out: PixelRecord = {};
  for (const [platform, config] of Object.entries(src)) {
    if (!config || typeof config !== 'object') {
      out[platform] = config;
      continue;
    }
    const next: Record<string, unknown> = { ...config };
    for (const field of SECRET_FIELDS) {
      const val = next[field];
      if (typeof val === 'string' && val.length > 0) {
        next[field] = encryption.mask(val, 4);
      }
    }
    out[platform] = next;
  }
  return out;
}

/**
 * Return a copy of `pixels` with every secret field removed entirely. Use for
 * the public storefront payload — the browser never needs CAPI/Events tokens.
 */
export function stripMarketingPixelSecrets(pixels: unknown): unknown {
  if (!pixels || typeof pixels !== 'object') return pixels;
  const src = pixels as PixelRecord;
  const out: PixelRecord = {};
  for (const [platform, config] of Object.entries(src)) {
    if (!config || typeof config !== 'object') {
      out[platform] = config;
      continue;
    }
    const next: Record<string, unknown> = { ...config };
    for (const field of SECRET_FIELDS) {
      delete next[field];
    }
    out[platform] = next;
  }
  return out;
}

/**
 * Merge an incoming `marketingPixels` payload over the currently-stored value,
 * preserving any secret whose incoming value is still the mask sentinel. This
 * is what stops a "Save" with an untouched, masked token from clobbering the
 * real stored secret with `****` text.
 */
export function preserveMaskedPixelSecrets(incoming: unknown, stored: unknown): unknown {
  if (!incoming || typeof incoming !== 'object') return incoming;
  const inc = incoming as PixelRecord;
  const cur = (stored && typeof stored === 'object' ? stored : {}) as PixelRecord;
  const out: PixelRecord = {};
  for (const [platform, config] of Object.entries(inc)) {
    if (!config || typeof config !== 'object') {
      out[platform] = config;
      continue;
    }
    const next: Record<string, unknown> = { ...config };
    for (const field of SECRET_FIELDS) {
      if (isMasked(next[field])) {
        const storedVal = cur[platform]?.[field];
        // Keep the real stored secret; if there is none, drop the mask text
        // rather than persisting `****` as a credential.
        if (typeof storedVal === 'string' && storedVal.length > 0) {
          next[field] = storedVal;
        } else {
          delete next[field];
        }
      }
    }
    out[platform] = next;
  }
  return out;
}
