import { AppError } from '../middleware/error-handler';
import logger from '../lib/logger';
import { deleteR2ObjectIfOrphan } from './r2-cleanup.service';
import { withSavepoint } from '../lib/savepoint';
import { storeDb, storeWriter } from '../lib/repo-factory';

/**
 * Per-store Pages CMS service.
 *
 * Backs the StorePage table - long-form merchant-editable content for
 * About / Privacy / Terms / Shipping / FAQ + custom pages. Content is
 * stored as a typed Block[] per locale (JSONB) so the admin UI can
 * present labeled fields per block type instead of a markdown textarea
 * (merchants reported "normal people don't know markdown"). The
 * storefront receives HTML pre-rendered by `renderBlocksToHtml`, which
 * escapes every text input and restricts URL schemes - no client-side
 * sanitizer dependency required.
 *
 * Slugs are normalized to lowercase + dash to keep URL paths predictable
 * across the storefront. Reserved built-in slugs (`about`, `privacy`,
 * `terms`, `shipping`, `faq`) are not gated here - merchants may freely
 * add custom slugs alongside the built-ins.
 */

// Arabic letters allowed, like product slugs (a page titled «صفحة اختبار» gets an Arabic address).
const SLUG_REGEX = /^[a-z0-9؀-ۿ](?:[a-z0-9؀-ۿ-]{0,62}[a-z0-9؀-ۿ])?$/;

/**
 * Standard pages: a store admin may edit them but never delete them (the storefront and legal links expect them).
 * Mirrored in the admin UI (content/page-slug.ts). A super_admin may still remove a shell.
 */
export const PROTECTED_PAGE_SLUGS: readonly string[] = [
  'home',
  'about',
  'privacy',
  'terms',
  'shipping',
  'faq',
  'legal',
  'returns',
  'refund',
  'cookies',
  'contact',
];

/** True when this role may delete this page: custom pages for a store admin, any page for a super admin. */
export function canDeletePage(role: string | undefined, slugRaw: string): boolean {
  if (role === 'super_admin') return true;
  return role === 'store_admin' && !PROTECTED_PAGE_SLUGS.includes(normalizeSlug(slugRaw));
}

function normalizeSlug(input: string): string {
  return input.trim().toLowerCase();
}

function assertValidSlug(slug: string): void {
  if (!SLUG_REGEX.test(slug)) {
    throw new AppError(
      400,
      'INVALID_SLUG',
      'Slug must be 1-64 chars: lowercase letters, Arabic letters, digits, dashes (cannot start/end with dash)'
    );
  }
}

// ---------- Block schema (mirrored in admin editor + Zod validator) ----------

export type HeadingBlock = { type: 'heading'; level: 2 | 3; text: string };
export type ParagraphBlock = { type: 'paragraph'; text: string };
export type BulletsBlock = { type: 'bullets'; items: string[] };
export type NumberedBlock = { type: 'numbered'; items: string[] };
export type ImageBlock = { type: 'image'; url: string; alt: string };
export type ButtonBlock = { type: 'button'; label: string; url: string };

export type Block =
  | HeadingBlock
  | ParagraphBlock
  | BulletsBlock
  | NumberedBlock
  | ImageBlock
  | ButtonBlock;

// ---------- Renderer (XSS-safe; output goes to the storefront verbatim) ----------

const HTML_ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, ch => HTML_ESCAPE[ch] || ch);
}

/**
 * Allow only the URL schemes we control. Reject `javascript:`, `data:`,
 * `vbscript:`, etc. Returned value is HTML-escaped so the caller can
 * drop it straight into an attribute.
 */
function safeUrl(url: string): string {
  const trimmed = (url ?? '').trim();
  if (!trimmed) return '#';
  if (/^(\/|#|\?|\.\/|\.\.\/)/.test(trimmed)) return escapeHtml(trimmed);
  if (/^(https?:|mailto:|tel:)/i.test(trimmed)) return escapeHtml(trimmed);
  return '#';
}

/**
 * Render a typed block array to HTML. Every string input is HTML-escaped
 * before interpolation, every URL passes through `safeUrl`, and only a
 * fixed set of wrapper tags is emitted. The result is safe for the
 * storefront to insert directly.
 *
 * Unknown block shapes are skipped silently - the upsert layer rejects
 * them with Zod, but a defensive fallback keeps a malformed row from
 * breaking the storefront.
 */
function renderBlocksToHtml(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  const out: string[] = [];

  for (const raw of blocks) {
    if (!raw || typeof raw !== 'object') continue;
    const b = raw as Partial<Block> & { type?: string };
    switch (b.type) {
      case 'heading': {
        const level = b.level === 3 ? 3 : 2;
        const text = escapeHtml(typeof b.text === 'string' ? b.text : '');
        if (text) out.push(`<h${level}>${text}</h${level}>`);
        break;
      }
      case 'paragraph': {
        const raw = typeof b.text === 'string' ? b.text : '';
        if (!raw.trim()) break;
        // Preserve intentional line breaks within a paragraph.
        const lines = raw.replace(/\r\n/g, '\n').split('\n').map(escapeHtml);
        out.push(`<p>${lines.join('<br />')}</p>`);
        break;
      }
      case 'bullets':
      case 'numbered': {
        const tag = b.type === 'bullets' ? 'ul' : 'ol';
        const items = Array.isArray(b.items) ? b.items : [];
        const li = items
          .filter((it): it is string => typeof it === 'string' && it.trim().length > 0)
          .map(it => `<li>${escapeHtml(it)}</li>`)
          .join('');
        if (li) out.push(`<${tag}>${li}</${tag}>`);
        break;
      }
      case 'image': {
        const url = typeof b.url === 'string' ? b.url : '';
        if (!url.trim()) break;
        const alt = escapeHtml(typeof b.alt === 'string' ? b.alt : '');
        out.push(
          `<figure class="cms-image"><img src="${safeUrl(
            url
          )}" alt="${alt}" loading="lazy" /></figure>`
        );
        break;
      }
      case 'button': {
        const url = typeof b.url === 'string' ? b.url : '';
        const label = escapeHtml(typeof b.label === 'string' ? b.label : '');
        if (!url.trim() || !label) break;
        // External links open in a new tab; relative links stay in-app.
        const isExternal = /^https?:/i.test(url.trim());
        const target = isExternal ? ' target="_blank" rel="noopener noreferrer"' : '';
        out.push(
          `<p class="cms-button-row"><a class="cms-button" href="${safeUrl(
            url
          )}"${target}>${label}</a></p>`
        );
        break;
      }
      default:
        // Unknown block type - drop it silently.
        break;
    }
  }

  return out.join('\n');
}

export interface StorePagePayload {
  title?: string | null;
  titleAr?: string | null;
  contentBlocks?: Block[] | null;
  contentBlocksAr?: Block[] | null;
  coverImage?: string | null;
  isPublished?: boolean;
  position?: number;
}

export type PublicPageResult =
  | { status: 'not_found' }
  | { status: 'disabled' }
  | {
      status: 'ok';
      page: {
        id: string;
        storeId: string;
        slug: string;
        title: string | null;
        titleAr: string | null;
        coverImage: string | null;
        isPublished: boolean;
        contentHtml: string;
        contentHtmlAr: string;
        // ISO 8601. Lets the storefront show a real "Last updated" date for a
        // merchant-authored CMS page instead of either always showing
        // today's date or (as it did previously) showing no date at all on
        // this path — see C1-2 in the 2026-09-22 AEO audit.
        updatedAt: string;
      };
    };

export class PagesService {
  /** List all pages for a store, ordered by position then slug. */
  static async list(storeId: string) {
    const db = await storeDb(storeId); // pg today; the store's Durable Object once its flag says 'do' (CF-REPO-1)
    return db.storePage.findMany({
      where: { storeId },
      orderBy: [{ position: 'asc' }, { slug: 'asc' }],
    });
  }

  /** Fetch a single page by slug. Returns null when not found. */
  static async get(storeId: string, slugRaw: string) {
    const slug = normalizeSlug(slugRaw);
    const db = await storeDb(storeId);
    return db.storePage.findUnique({
      where: { storeId_slug: { storeId, slug } },
    });
  }

  /**
   * Public-facing fetch with three-state semantics:
   *
   *   - `not_found` -> no row exists. Storefront should fall back to its
   *     legacy hardcoded copy so stores that haven't migrated keep
   *     working.
   *   - `disabled`  -> row exists but `isPublished` is false. Storefront
   *     should render a "Page unavailable" message and MUST NOT show
   *     the legacy fallback. This is the explicit "hard-off" toggle
   *     merchants asked for.
   *   - `ok`        -> row exists and is enabled. The returned `page`
   *     carries pre-rendered HTML (`contentHtml` / `contentHtmlAr`) so
   *     the storefront doesn't need its own renderer.
   */
  static async getPublic(storeId: string, slugRaw: string): Promise<PublicPageResult> {
    const slug = normalizeSlug(slugRaw);
    const db = await storeDb(storeId);
    const page = await db.storePage.findUnique({
      where: { storeId_slug: { storeId, slug } },
    });
    if (!page) return { status: 'not_found' };
    if (!page.isPublished) return { status: 'disabled' };
    return {
      status: 'ok',
      page: {
        id: page.id,
        storeId: page.storeId,
        slug: page.slug,
        title: page.title,
        titleAr: page.titleAr,
        coverImage: page.coverImage,
        isPublished: page.isPublished,
        contentHtml: renderBlocksToHtml(page.contentBlocks),
        contentHtmlAr: renderBlocksToHtml(page.contentBlocksAr),
        updatedAt: page.updatedAt.toISOString(),
      },
    };
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

    const updateData: Record<string, unknown> = {};
    if (payload.title !== undefined) updateData.title = payload.title;
    if (payload.titleAr !== undefined) updateData.titleAr = payload.titleAr;
    if (payload.contentBlocks !== undefined) {
      updateData.contentBlocks = payload.contentBlocks ?? null;
    }
    if (payload.contentBlocksAr !== undefined) {
      updateData.contentBlocksAr = payload.contentBlocksAr ?? null;
    }
    if (payload.coverImage !== undefined) updateData.coverImage = payload.coverImage;
    if (payload.isPublished !== undefined) updateData.isPublished = payload.isPublished;
    if (payload.position !== undefined) updateData.position = payload.position;

    const createData = {
      storeId,
      slug,
      title: payload.title ?? null,
      titleAr: payload.titleAr ?? null,
      contentBlocks: (payload.contentBlocks ?? null) as never,
      contentBlocksAr: (payload.contentBlocksAr ?? null) as never,
      coverImage: payload.coverImage ?? null,
      isPublished: payload.isPublished ?? true,
      position: payload.position ?? 0,
    };

    // Snapshot the previous coverImage so the R2 object behind a replaced
    // banner gets queued for cleanup post-write. Fetch is best-effort —
    // if the row doesn't exist yet (create path) `previous` is null and
    // the cleanup is a no-op.
    const w = await storeWriter(storeId); // pg today; the store's Durable Object once its flag says 'do' (CF-WRITES-1)
    const existing =
      payload.coverImage !== undefined
        ? await w.storePage.findUnique({
            where: { storeId_slug: { storeId, slug } },
            select: { coverImage: true },
          })
        : null;
    const previousCover = existing?.coverImage ?? null;

    const page = await w.storePage.upsert({
      where: { storeId_slug: { storeId, slug } },
      create: createData,
      update: updateData,
    });

    if (
      payload.coverImage !== undefined &&
      previousCover &&
      previousCover !== (payload.coverImage ?? null)
    ) {
      void deleteR2ObjectIfOrphan(previousCover).catch(err =>
        logger.warn({ err, storeId, slug }, '[pages.upsert] r2 cleanup failed')
      );
    }

    return page;
  }

  /**
   * Delete a page. Reserved for super_admin per the route layer - we
   * don't want a store_admin nuking a critical legal page by accident.
   */
  static async remove(storeId: string, slugRaw: string) {
    const slug = normalizeSlug(slugRaw);
    // Fetch coverImage BEFORE delete so we can clean up R2 after
    // commit — mirrors BlogService.remove.
    const w = await storeWriter(storeId);
    const existing = await w.storePage.findUnique({
      where: { storeId_slug: { storeId, slug } },
      select: { coverImage: true },
    });
    try {
      // Savepointed and P2025-only (issue 2215's class): this runs in the
      // request's tenant transaction, and the old bare catch treated ANY
      // error as "already deleted" — an FK/RLS failure aborted the
      // transaction while the route answered success.
      await withSavepoint(() =>
        w.storePage.delete({
          where: { storeId_slug: { storeId, slug } },
        })
      );
    } catch (err) {
      // P2025 = record not found. Treat as idempotent delete.
      if ((err as { code?: string }).code === 'P2025') return;
      throw err;
    }
    if (existing?.coverImage) {
      void deleteR2ObjectIfOrphan(existing.coverImage).catch(err =>
        logger.warn({ err, storeId, slug }, '[pages.remove] r2 cleanup failed')
      );
    }
  }
}
