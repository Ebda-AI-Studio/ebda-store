'use client';

import { storeNumerals } from '@ebda/shared';
import { useEffect, useState } from 'react';
import Image from 'next/image';
import { useStore } from '../contexts/StoreContext';
import { useLanguage } from '../contexts/LanguageContext';
import { API_URL } from '../lib/api';
import { formatDate } from '../lib/format-date';

/**
 * Shape of a public StorePage row as returned by the API. The API
 * pre-renders the block array to HTML server-side so the storefront
 * does not need a renderer or sanitizer dependency.
 */
interface PublicStorePage {
  id: string;
  storeId: string;
  slug: string;
  title?: string | null;
  titleAr?: string | null;
  coverImage?: string | null;
  isPublished: boolean;
  contentHtml?: string | null;
  contentHtmlAr?: string | null;
  /** ISO 8601. Absent only if a stale cached response predates this field —
   *  guarded at the render site below. */
  updatedAt?: string;
}

type FetchState =
  | { kind: 'loading' }
  | { kind: 'ok'; page: PublicStorePage }
  | { kind: 'fallback' } // missing row OR empty content -> show legacy hardcoded copy
  | { kind: 'disabled' }; // explicit hard-off; do NOT show fallback

interface CmsPageContentProps {
  slug: string;
  defaultTitle: { en: string; ar: string };
  fallback: () => React.ReactNode;
}

/**
 * Storefront renderer for a CMS-managed page.
 *
 * Three response paths from /public/:storeId/pages/:slug:
 *   - 200 with non-empty contentHtml  -> render the merchant's content
 *   - 200 with empty contentHtml      -> treat like missing row, fall back
 *   - 200 with `page: null`           -> no row; fall back to legacy hardcoded copy
 *     (a 404 means the same and is still handled: it is what an API older than
 *     this storefront answers, and it costs the shopper's per-IP miss budget)
 *   - 410 PAGE_DISABLED               -> render "Page unavailable" (no fallback)
 *
 * The 410 path is the merchant's "hard off" toggle: when they turn the
 * "Show on storefront" switch off, the page is unavailable and the
 * platform's default copy must NOT silently appear.
 *
 * The HTML is rendered by the API and every text input is HTML-escaped
 * before reaching this component, so the inserted markup is safe.
 */
export function CmsPageContent({ slug, defaultTitle, fallback }: CmsPageContentProps) {
  const { store } = useStore();
  const { language, t } = useLanguage();
  const [state, setState] = useState<FetchState>({ kind: 'loading' });

  useEffect(() => {
    if (!store.id || store.id === 'demo') {
      setState({ kind: 'fallback' });
      return;
    }

    let cancelled = false;
    setState({ kind: 'loading' });

    fetch(`${API_URL}/public/${store.id}/pages/${slug}`)
      .then(async res => {
        if (cancelled) return;
        if (res.status === 410) {
          setState({ kind: 'disabled' });
          return;
        }
        if (res.status === 404) {
          setState({ kind: 'fallback' });
          return;
        }
        if (!res.ok) {
          // Network or 5xx - prefer fallback so legacy copy still shows.
          setState({ kind: 'fallback' });
          return;
        }
        const json = await res.json();
        const page = json?.data?.page as PublicStorePage | null | undefined;
        if (!page) {
          setState({ kind: 'fallback' });
          return;
        }
        // Empty content (both locales blank) is treated like a missing
        // row so a half-configured page still falls back gracefully.
        const hasAny =
          (page.contentHtml && page.contentHtml.trim()) ||
          (page.contentHtmlAr && page.contentHtmlAr.trim());
        if (!hasAny) {
          setState({ kind: 'fallback' });
          return;
        }
        setState({ kind: 'ok', page });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'fallback' });
      });

    return () => {
      cancelled = true;
    };
  }, [store.id, slug]);

  if (state.kind === 'loading') {
    return (
      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6 lg:px-8">
        <div className="flex items-center justify-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      </div>
    );
  }

  if (state.kind === 'disabled') {
    // Hard off - do NOT call fallback. Merchant explicitly disabled this page.
    return (
      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-16 text-center sm:px-6 lg:px-8">
        <div className="rounded-2xl border bg-card p-10 shadow-sm">
          <h1 className="text-2xl font-semibold text-foreground">
            {t('Page unavailable', 'الصفحة غير متاحة')}
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            {t('This page is currently turned off by the store.', 'المتجر وقّف الصفحة دي دلوقتي.')}
          </p>
        </div>
      </div>
    );
  }

  if (state.kind === 'fallback') {
    return <>{fallback()}</>;
  }

  const page = state.page;
  const localizedHtml =
    language === 'ar'
      ? page.contentHtmlAr || page.contentHtml || ''
      : page.contentHtml || page.contentHtmlAr || '';

  // Defensive: the empty case is already handled above, but guard again
  // in case both locales got cleared between fetch and render.
  if (!localizedHtml.trim()) {
    return <>{fallback()}</>;
  }

  const title =
    (language === 'ar' ? page.titleAr : page.title) ||
    page.title ||
    page.titleAr ||
    (language === 'ar' ? defaultTitle.ar : defaultTitle.en);

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6 lg:px-8">
      {page.coverImage && (
        <div className="relative mb-8 aspect-[3/1] w-full overflow-hidden rounded-xl bg-muted">
          <Image
            src={page.coverImage}
            alt={title}
            fill
            sizes="(max-width: 768px) 100vw, 768px"
            className="object-cover"
            unoptimized
          />
        </div>
      )}
      <div className="text-center">
        <h1 className="text-3xl font-bold text-foreground">{title}</h1>
        {/* Merchant-authored legal pages previously showed NO "Last updated"
         *  date at all on this path (the fallback copy's always-today date
         *  was the only place it ever rendered) — C1-2 in the 2026-09-22
         *  AEO audit. Scoped to privacy/terms only, matching the fallback's
         *  own scope; other CMS page types (about, faq, shipping, custom)
         *  were never asked to carry this claim. */}
        {(slug === 'privacy' || slug === 'terms') && page.updatedAt && (
          <p className="mt-2 text-muted-foreground">
            {t('Last updated:', 'آخر تحديث:')}{' '}
            {formatDate(page.updatedAt, {
              timezone: store.timezone,
              language,
              numerals: storeNumerals(store?.theme),
              style: 'long',
            })}
          </p>
        )}
      </div>
      <div className="mt-12 rounded-xl border bg-card p-6 shadow-sm sm:p-8">
        <div
          className="cms-markdown prose prose-gray max-w-none text-muted-foreground"
          dangerouslySetInnerHTML={{ __html: localizedHtml }}
        />
      </div>
    </div>
  );
}
