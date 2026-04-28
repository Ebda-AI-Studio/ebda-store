'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import { useStore } from '../contexts/StoreContext';
import { useLanguage } from '../contexts/LanguageContext';
import { API_URL } from '../lib/api';
import { renderMarkdown } from '../lib/markdown';

/**
 * Shape of a StorePage row as returned by the public read endpoint.
 * Fields mirror the Prisma model — the server already filters out
 * unpublished rows (returns 404), so client code can assume any row
 * received here is meant to be visible.
 */
interface StorePage {
  id: string;
  storeId: string;
  slug: string;
  title?: string | null;
  titleAr?: string | null;
  contentMd?: string | null;
  contentMdAr?: string | null;
  coverImage?: string | null;
  isPublished: boolean;
}

interface CmsPageContentProps {
  slug: string;
  defaultTitle: { en: string; ar: string };
  fallback: () => React.ReactNode;
}

/**
 * Storefront renderer for a CMS-managed page.
 *
 * Fetches /public/:storeId/pages/:slug from the API. When the row exists
 * and has content, renders title + cover + markdown HTML. When missing
 * OR contentMd is empty, falls through to the `fallback` render-prop so
 * existing stores keep their hardcoded copy until they write content.
 *
 * The markdown renderer (`renderMarkdown`) escapes all user input and
 * restricts URL protocols, so the dangerouslySetInnerHTML below only
 * receives HTML built from known-safe wrappers — no third-party
 * sanitizer dep needed.
 */
export function CmsPageContent({ slug, defaultTitle, fallback }: CmsPageContentProps) {
  const { store } = useStore();
  const { language } = useLanguage();
  const [page, setPage] = useState<StorePage | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    if (!store.id || store.id === 'demo') {
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setHasError(false);

    fetch(`${API_URL}/public/${store.id}/pages/${slug}`)
      .then(async res => {
        if (!res.ok) {
          if (res.status === 404) return null;
          throw new Error(`HTTP ${res.status}`);
        }
        const json = await res.json();
        return json?.data?.page ?? null;
      })
      .then(p => {
        if (!cancelled) setPage(p);
      })
      .catch(() => {
        if (!cancelled) setHasError(true);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [store.id, slug]);

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6 lg:px-8">
        <div className="flex items-center justify-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      </div>
    );
  }

  const localizedContent =
    language === 'ar' ? page?.contentMdAr || page?.contentMd : page?.contentMd || page?.contentMdAr;
  const hasUsableContent = !!(localizedContent && localizedContent.trim());

  if (hasError || !page || !hasUsableContent) {
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
      </div>
      <div className="mt-12 rounded-xl border bg-card p-6 shadow-sm sm:p-8">
        <div
          className="cms-markdown prose prose-gray max-w-none text-muted-foreground"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(localizedContent) }}
        />
      </div>
    </div>
  );
}
