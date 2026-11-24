/** Same alphabet the API accepts for a product slug (product.routes.ts): lowercase latin, digits, Arabic, hyphen. */
const SLUG_RE = /^[a-z0-9؀-ۿ-]+$/;

function normalizeSlugInput(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidProductSlug(raw: string): boolean {
  const s = normalizeSlugInput(raw);
  return s.length > 0 && s.length <= 255 && SLUG_RE.test(s);
}

/**
 * The `slug` key for the update body: only when the merchant actually changed
 * it. Omitting it leaves the stored slug alone; the API then records the
 * SlugRedirect from the old slug on a real change.
 */
export function slugForUpdate(formSlug: string, storedSlug: string): { slug?: string } {
  const next = normalizeSlugInput(formSlug);
  return next && next !== storedSlug ? { slug: next } : {};
}

/**
 * The slug the API actually saved when it differs from the one the merchant asked for (a taken slug gets `-1`, `-2`... appended),
 * else null. The edit page tells the merchant the real link instead of letting them believe their text was kept.
 */
export function savedSlugIfChanged(requested: string | undefined, saved: unknown): string | null {
  if (!requested || typeof saved !== 'string' || saved === '') return null;
  return saved !== requested ? saved : null;
}
