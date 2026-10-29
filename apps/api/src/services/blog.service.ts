import { prisma, SlugEntityType } from '@ebda/database';
import { AppError } from '../middleware/error-handler';
import logger from '../lib/logger';
import { deleteR2ObjectIfOrphan } from './r2-cleanup.service';
import { recordSlugRedirect } from './slug-redirect.service';
import { storeDb, storeWriter } from '../lib/repo-factory';

/**
 * Per-store blog service (Bucket E1, 2026-05-17).
 *
 * Posts are bilingual (EN + AR) with optional cover image. `isPublished`
 * gates public visibility; `publishedAt` snaps to the moment the flag
 * flips to true (used for sorting + Article schema published_time).
 *
 * Content is stored as plain text with `\n\n` paragraph separators —
 * the storefront renderer escapes every text node so there's no XSS
 * surface in the body. Future rich-text content lands via a
 * `contentBlocks` JSON column mirroring StorePage.
 *
 * R2 cleanup is wired into update + delete for `coverImage` per the
 * 2026-05-17 standing rule (every image-bearing column drops its old
 * R2 object on replacement).
 */

const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,79}[a-z0-9])?$/;

function normalizeSlug(input: string): string {
  return input.trim().toLowerCase();
}

function assertValidSlug(slug: string): void {
  if (!SLUG_REGEX.test(slug)) {
    throw new AppError(
      400,
      'INVALID_SLUG',
      'Slug must be lowercase letters, numbers, and dashes (1-80 chars)'
    );
  }
}

export interface BlogPostPayload {
  slug: string;
  title: string;
  titleAr?: string | null;
  excerpt?: string | null;
  excerptAr?: string | null;
  content: string;
  contentAr?: string | null;
  coverImage?: string | null;
  isPublished?: boolean;
}

export class BlogService {
  /**
   * Public-read: list published posts for a store, newest-first.
   * Falls back to `createdAt` when `publishedAt` is null (legacy posts).
   */
  static async listPublished(storeId: string, options: { limit?: number; offset?: number } = {}) {
    const limit = Math.min(50, Math.max(1, options.limit ?? 20));
    const offset = Math.max(0, options.offset ?? 0);
    const db = await storeDb(storeId); // pg today; the store's Durable Object once its flag says 'do' (CF-REPO-1)
    const posts = await db.blogPost.findMany({
      where: { storeId, isPublished: true },
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
      take: limit,
      skip: offset,
      select: {
        id: true,
        slug: true,
        title: true,
        titleAr: true,
        excerpt: true,
        excerptAr: true,
        coverImage: true,
        publishedAt: true,
        createdAt: true,
      },
    });
    return posts;
  }

  /** Public-read: single post by slug. Returns null if unpublished. */
  static async getPublishedBySlug(storeId: string, slugRaw: string) {
    const slug = normalizeSlug(slugRaw);
    const db = await storeDb(storeId);
    const post = await db.blogPost.findFirst({
      where: { storeId, slug, isPublished: true },
      select: {
        id: true,
        slug: true,
        title: true,
        titleAr: true,
        excerpt: true,
        excerptAr: true,
        content: true,
        contentAr: true,
        coverImage: true,
        publishedAt: true,
        createdAt: true,
      },
    });
    return post;
  }

  /** Admin-read: list all posts (including drafts), newest first. */
  static async listAll(storeId: string) {
    const db = await storeDb(storeId);
    return db.blogPost.findMany({
      where: { storeId },
      orderBy: [{ createdAt: 'desc' }],
    });
  }

  /** Admin-read: single post by id. */
  static async getById(storeId: string, postId: string) {
    const db = await storeDb(storeId);
    const post = await db.blogPost.findFirst({
      where: { id: postId, storeId },
    });
    if (!post) throw new AppError(404, 'NOT_FOUND', 'Blog post not found');
    return post;
  }

  static async create(storeId: string, payload: BlogPostPayload) {
    const slug = normalizeSlug(payload.slug);
    assertValidSlug(slug);
    // Slug uniqueness check up front so the merchant sees a clean error
    // instead of a generic Prisma P2002 unique-violation.
    const w = await storeWriter(storeId); // pg today; the store's Durable Object once its flag says 'do' (CF-WRITES-1)
    const existing = await w.blogPost.findUnique({
      where: { storeId_slug: { storeId, slug } },
    });
    if (existing) {
      throw new AppError(409, 'SLUG_TAKEN', 'A blog post with that slug already exists');
    }
    const isPublished = payload.isPublished === true;
    return w.blogPost.create({
      data: {
        storeId,
        slug,
        title: payload.title,
        titleAr: payload.titleAr ?? null,
        excerpt: payload.excerpt ?? null,
        excerptAr: payload.excerptAr ?? null,
        content: payload.content,
        contentAr: payload.contentAr ?? null,
        coverImage: payload.coverImage ?? null,
        isPublished,
        publishedAt: isPublished ? new Date() : null,
      },
    });
  }

  static async update(storeId: string, postId: string, payload: Partial<BlogPostPayload>) {
    const existing = await this.getById(storeId, postId);
    const previousCover = existing.coverImage;

    let newSlug: string | undefined;
    if (payload.slug !== undefined) {
      newSlug = normalizeSlug(payload.slug);
      assertValidSlug(newSlug);
      if (newSlug !== existing.slug) {
        const collision = await (
          await storeDb(storeId)
        ).blogPost.findUnique({
          where: { storeId_slug: { storeId, slug: newSlug } },
        });
        if (collision && collision.id !== postId) {
          throw new AppError(409, 'SLUG_TAKEN', 'A blog post with that slug already exists');
        }
      }
    }

    const updateData: Record<string, unknown> = {};
    if (newSlug !== undefined) updateData.slug = newSlug;
    if (payload.title !== undefined) updateData.title = payload.title;
    if (payload.titleAr !== undefined) updateData.titleAr = payload.titleAr;
    if (payload.excerpt !== undefined) updateData.excerpt = payload.excerpt;
    if (payload.excerptAr !== undefined) updateData.excerptAr = payload.excerptAr;
    if (payload.content !== undefined) updateData.content = payload.content;
    if (payload.contentAr !== undefined) updateData.contentAr = payload.contentAr;
    if (payload.coverImage !== undefined) updateData.coverImage = payload.coverImage;
    if (payload.isPublished !== undefined) {
      updateData.isPublished = payload.isPublished;
      // Snap publishedAt when the flag flips. Once set we leave it
      // alone on subsequent edits so the canonical published date
      // stays stable for SEO / sitemap.
      if (payload.isPublished === true && !existing.publishedAt) {
        updateData.publishedAt = new Date();
      } else if (payload.isPublished === false) {
        // Unpublishing keeps publishedAt for history but the public
        // routes will gate on isPublished anyway.
      }
    }

    // Blog routes are mounted under `tenantContext` middleware, which already
    // wraps the whole request in one ambient tenant transaction (RLS GUC set
    // via `runInTenantContext`). Calling the proxied `prisma` directly (not a
    // nested `prisma.$transaction`) lets both the update and the capture ride
    // that ambient tx — atomic, and RLS-enforced.
    const updated = await (
      await storeWriter(storeId)
    ).blogPost.update({
      where: { id: postId, storeId },
      data: updateData,
    });

    if (newSlug !== undefined && newSlug !== existing.slug) {
      await recordSlugRedirect(prisma, storeId, SlugEntityType.BLOG, existing.slug, newSlug);
    }

    if (
      payload.coverImage !== undefined &&
      previousCover &&
      previousCover !== (payload.coverImage ?? null)
    ) {
      void deleteR2ObjectIfOrphan(previousCover).catch(err =>
        logger.warn({ err, storeId, postId }, '[blog.update] r2 cleanup failed')
      );
    }

    return updated;
  }

  static async remove(storeId: string, postId: string) {
    const existing = await this.getById(storeId, postId);
    await (await storeWriter(storeId)).blogPost.delete({ where: { id: postId, storeId } });
    if (existing.coverImage) {
      void deleteR2ObjectIfOrphan(existing.coverImage).catch(err =>
        logger.warn({ err, storeId, postId }, '[blog.remove] r2 cleanup failed')
      );
    }
  }
}
