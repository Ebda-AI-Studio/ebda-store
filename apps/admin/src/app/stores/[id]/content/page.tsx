'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useToast } from '@ebda/ui';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet } from '../../../../lib/api';

interface StorePageRow {
  id: string;
  storeId: string;
  slug: string;
  title?: string | null;
  titleAr?: string | null;
  contentBlocks?: unknown;
  contentBlocksAr?: unknown;
  isPublished: boolean;
  position: number;
  updatedAt?: string;
}

const BUILT_IN_SLUGS: Array<{ slug: string; en: string; ar: string }> = [
  { slug: 'about', en: 'About Us', ar: 'من نحن' },
  { slug: 'privacy', en: 'Privacy Policy', ar: 'سياسة الخصوصية' },
  { slug: 'terms', en: 'Terms of Service', ar: 'الشروط والأحكام' },
  { slug: 'shipping', en: 'Shipping Policy', ar: 'سياسة الشحن' },
  { slug: 'faq', en: 'FAQ', ar: 'الأسئلة الشائعة' },
];

const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

// A page is considered "authored" when at least one block array has any
// item. Blocks are arrays of typed objects so the truthiness check is
// "non-empty array" rather than "non-empty string".
function hasContent(p: StorePageRow): boolean {
  const en = Array.isArray(p.contentBlocks) ? p.contentBlocks.length > 0 : false;
  const ar = Array.isArray(p.contentBlocksAr) ? p.contentBlocksAr.length > 0 : false;
  return en || ar;
}

export default function ContentListPage() {
  const params = useParams();
  const router = useRouter();
  const storeId = params?.id as string;
  const t = useT('content.list');
  const { error: toastError } = useToast();

  const [pages, setPages] = useState<StorePageRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchPages = useCallback(async () => {
    if (!storeId) return;
    setIsLoading(true);
    const { data, error } = await apiGet<{ pages: StorePageRow[] }>(
      `/api/v1/stores/${storeId}/pages`
    );
    if (error) {
      toastError(t('loadError'));
    } else if (data?.pages) {
      setPages(data.pages);
    }
    setIsLoading(false);
  }, [storeId, t, toastError]);

  useEffect(() => {
    fetchPages();
  }, [fetchPages]);

  const handleNewPage = () => {
    const raw = window.prompt(t('newPagePrompt'));
    if (!raw) return;
    const slug = raw.trim().toLowerCase();
    if (!SLUG_REGEX.test(slug)) {
      toastError(t('newPagePrompt'));
      return;
    }
    router.push(`/stores/${storeId}/content/${encodeURIComponent(slug)}`);
  };

  const pagesBySlug = new Map(pages.map(p => [p.slug, p]));
  const customPages = pages.filter(p => !BUILT_IN_SLUGS.some(b => b.slug === p.slug));

  return (
    <AdminLayout
      mode="store_admin"
      storeId={storeId}
      title={t('title')}
      subtitle={t('subtitle')}
      actions={
        <button
          type="button"
          onClick={handleNewPage}
          className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
        >
          {t('newPage')}
        </button>
      }
    >
      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
        <p className="mb-6 rounded-xl bg-muted/40 p-4 text-sm text-muted-foreground">
          {t('emptyHint')}{' '}
          <Link
            href={`/stores/${storeId}/content/faqs`}
            className="font-medium text-primary-ink underline underline-offset-2"
          >
            {t('faqsLink')}
          </Link>
        </p>

        {isLoading ? (
          <div className="rounded-2xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            …
          </div>
        ) : (
          <>
            <h2 className="mb-3 text-lg font-semibold text-foreground">{t('builtInsHeading')}</h2>
            <ul className="mb-8 space-y-3">
              {BUILT_IN_SLUGS.map(b => {
                const row = pagesBySlug.get(b.slug);
                return (
                  <li key={b.slug}>
                    <PageRowCard
                      slug={b.slug}
                      defaultTitleEn={b.en}
                      defaultTitleAr={b.ar}
                      row={row}
                      storeId={storeId}
                      authoredLabel={t('authoredBadge')}
                      fallbackLabel={t('fallbackBadge')}
                      publishedLabel={t('publishedBadge')}
                      draftLabel={t('draftBadge')}
                      editLabel={t('openEditor')}
                    />
                  </li>
                );
              })}
            </ul>

            <h2 className="mb-3 text-lg font-semibold text-foreground">{t('customHeading')}</h2>
            {customPages.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border bg-card p-6 text-center text-sm text-muted-foreground">
                {t('customEmpty')}
              </p>
            ) : (
              <ul className="space-y-3">
                {customPages.map(p => (
                  <li key={p.id}>
                    <PageRowCard
                      slug={p.slug}
                      defaultTitleEn={p.title || p.slug}
                      defaultTitleAr={p.titleAr || p.title || p.slug}
                      row={p}
                      storeId={storeId}
                      authoredLabel={t('authoredBadge')}
                      fallbackLabel={t('fallbackBadge')}
                      publishedLabel={t('publishedBadge')}
                      draftLabel={t('draftBadge')}
                      editLabel={t('openEditor')}
                    />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </AdminLayout>
  );
}

function PageRowCard({
  slug,
  defaultTitleEn,
  defaultTitleAr,
  row,
  storeId,
  authoredLabel,
  fallbackLabel,
  publishedLabel,
  draftLabel,
  editLabel,
}: {
  slug: string;
  defaultTitleEn: string;
  defaultTitleAr: string;
  row: StorePageRow | undefined;
  storeId: string;
  authoredLabel: string;
  fallbackLabel: string;
  publishedLabel: string;
  draftLabel: string;
  editLabel: string;
}) {
  const authored = row ? hasContent(row) : false;
  const titleEn = row?.title?.trim() || defaultTitleEn;
  const titleAr = row?.titleAr?.trim() || defaultTitleAr;
  // The title in the admin's own language leads; the other language is the secondary line (audit S-5).
  const isAr = useLocale() === 'ar';
  const primaryTitle = isAr ? titleAr : titleEn;
  const secondaryTitle = isAr ? titleEn : titleAr;
  return (
    <Link
      href={`/stores/${storeId}/content/${encodeURIComponent(slug)}`}
      className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-accent/30"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-base font-semibold text-foreground">{primaryTitle}</span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-mono text-muted-foreground">
            {slug}
          </span>
        </div>
        <p className="mt-0.5 text-sm text-muted-foreground" dir={isAr ? 'ltr' : 'rtl'}>
          {secondaryTitle}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span
            className={`rounded-full px-2 py-0.5 ${
              authored
                ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
            }`}
          >
            {authored ? authoredLabel : fallbackLabel}
          </span>
          {row && (
            <span
              className={`rounded-full px-2 py-0.5 ${
                row.isPublished
                  ? 'bg-primary/10 text-primary-ink'
                  : 'bg-muted text-muted-foreground'
              }`}
            >
              {row.isPublished ? publishedLabel : draftLabel}
            </span>
          )}
        </div>
      </div>
      <span className="shrink-0 text-sm font-medium text-primary">{editLabel} →</span>
    </Link>
  );
}
