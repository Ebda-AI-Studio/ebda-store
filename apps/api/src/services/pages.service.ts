import { prisma } from '@force/database';
import { AppError } from '../middleware/error-handler';

/**
 * Per-store Pages CMS service.
 *
 * Backs the StorePage table — long-form merchant-editable content for
 * About / Privacy / Terms / Shipping / FAQ + custom pages. Content is
 * markdown; the storefront renders it via a tiny hand-rolled renderer
 * (no rich-text dependency).
 *
 * Slugs are normalized to lowercase + dash to keep URL paths predictable
 * across the storefront. Reserved built-in slugs (`about`, `privacy`,
 * `terms`, `shipping`, `faq`) are not gated here — merchants may freely
 * add custom slugs alongside the built-ins.
 */

const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function normalizeSlug(input: string): string {
  return input.trim().toLowerCase();
}

function assertValidSlug(slug: string): void {
  if (!SLUG_REGEX.test(slug)) {
    throw new AppError(
      400,
      'INVALID_SLUG',
      'Slug must be 1-64 chars: lowercase letters, digits, dashes (cannot start/end with dash)'
    );
  }
}

export interface StorePagePayload {
  title?: string | null;
  titleAr?: string | null;
  contentMd?: string | null;
  contentMdAr?: string | null;
  coverImage?: string | null;
  isPublished?: boolean;
  position?: number;
}

export class PagesService {
  /** List all pages for a store, ordered by position then slug. */
  static async list(storeId: string) {
    return prisma.storePage.findMany({
      where: { storeId },
      orderBy: [{ position: 'asc' }, { slug: 'asc' }],
    });
  }

  /** Fetch a single page by slug. Returns null when not found. */
  static async get(storeId: string, slugRaw: string) {
    const slug = normalizeSlug(slugRaw);
    return prisma.storePage.findUnique({
      where: { storeId_slug: { storeId, slug } },
    });
  }

  /**
   * Public-facing fetch. Returns null when the page is missing OR
   * unpublished — the storefront treats both cases the same and falls
   * through to legacy hardcoded copy.
   */
  static async getPublic(storeId: string, slugRaw: string) {
    const slug = normalizeSlug(slugRaw);
    const page = await prisma.storePage.findUnique({
      where: { storeId_slug: { storeId, slug } },
    });
    if (!page || !page.isPublished) return null;
    return page;
  }

  /**
   * Upsert a page identified by (storeId, slug). Creates the row on
   * first save with the supplied content, otherwise patches the
   * provided fields. `null` values explicitly clear a field; `undefined`
   * leaves the existing value untouched.
   */
  static async upsert(storeId: string, slugRaw: string, payload: StorePagePayload) {
    const slug = normalizeSlug(slugRaw);
    assertValidSlug(slug);

    // Build the create vs update payloads separately so PATCH semantics
    // (undefined = keep existing) line up with Prisma's behaviour.
    const updateData: Record<string, unknown> = {};
    if (payload.title !== undefined) updateData.title = payload.title;
    if (payload.titleAr !== undefined) updateData.titleAr = payload.titleAr;
    if (payload.contentMd !== undefined) updateData.contentMd = payload.contentMd;
    if (payload.contentMdAr !== undefined) updateData.contentMdAr = payload.contentMdAr;
    if (payload.coverImage !== undefined) updateData.coverImage = payload.coverImage;
    if (payload.isPublished !== undefined) updateData.isPublished = payload.isPublished;
    if (payload.position !== undefined) updateData.position = payload.position;

    const createData = {
      storeId,
      slug,
      title: payload.title ?? null,
      titleAr: payload.titleAr ?? null,
      contentMd: payload.contentMd ?? null,
      contentMdAr: payload.contentMdAr ?? null,
      coverImage: payload.coverImage ?? null,
      isPublished: payload.isPublished ?? true,
      position: payload.position ?? 0,
    };

    return prisma.storePage.upsert({
      where: { storeId_slug: { storeId, slug } },
      create: createData,
      update: updateData,
    });
  }

  /**
   * Delete a page. Reserved for super_admin per the route layer — we
   * don't want a store_admin nuking a critical legal page by accident.
   */
  static async remove(storeId: string, slugRaw: string) {
    const slug = normalizeSlug(slugRaw);
    try {
      await prisma.storePage.delete({
        where: { storeId_slug: { storeId, slug } },
      });
    } catch {
      // P2025 = record not found. Treat as idempotent delete.
    }
  }
}
