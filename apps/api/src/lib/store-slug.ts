import { validateStoreSlug, validateStoreSlugFormat } from '@force/shared';
import { AppError } from '../middleware/error-handler';

/**
 * Validate an explicitly supplied store slug (the merchant's `<slug>.ebda.app`).
 * Throws a 400 whose `code` is the stable `SLUG_*` reason — `SLUG_RESERVED` for
 * `app`, `api`, `www`, … — so the admin can show a specific message.
 */
export function assertStoreSlug(raw: string): string {
  const result = validateStoreSlug(raw);
  if (!result.ok) throw new AppError(400, result.code, result.message);
  return result.slug;
}

/**
 * Coerce a name-derived slug into one that passes slug validation: pad short
 * ones, trim long ones, collapse hyphens. The caller's de-dup loop then keeps
 * it unreserved and unique.
 */
export function deriveStoreSlug(derived: string): string {
  let slug = derived
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  while (slug.length < 3) slug += 'x';
  return validateStoreSlugFormat(slug).ok ? slug : `store-${Date.now().toString(36)}`;
}
