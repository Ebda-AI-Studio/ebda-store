'use client';

import { Button } from '@/components/ui/Button';
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { Modal, useToast } from '@ebda/ui';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiDelete, apiGet } from '../../../../lib/api';
import { useConfirm } from '@/hooks/useConfirm';
import { PAGE_SLUG_REGEX, isProtectedPageSlug, slugFromTitle } from './page-slug';

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
  const { error: toastError, success: toastSuccess } = useToast();
  const askConfirm = useConfirm();
  const [newPageOpen, setNewPageOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newSlug, setNewSlug] = useState(''); // advanced override; empty = derived from the title
  const [newSlugInvalid, setNewSlugInvalid] = useState(false);

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

  // In-app dialog, never window.prompt: a native prompt blocks the whole tab
  // (and every automation driver) until answered, which read as a freeze.
  const handleNewPage = () => {
    setNewTitle('');
    setNewSlug('');
    setNewSlugInvalid(false);
    setNewPageOpen(true);
  };

  const submitNewPage = () => {
    const title = newTitle.trim();
    const slug = (newSlug.trim() ? newSlug.trim().toLowerCase() : slugFromTitle(title)) || '';
    if ((!title && !newSlug.trim()) || !PAGE_SLUG_REGEX.test(slug)) {
      setNewSlugInvalid(true);
      return;
    }
    setNewPageOpen(false);
    const q = title ? `?title=${encodeURIComponent(title)}` : '';
    router.push(`/stores/${storeId}/content/${encodeURIComponent(slug)}${q}`);
  };

  const handleDelete = async (p: StorePageRow) => {
    const ok = await askConfirm({
      object: t('deleteObject', { name: p.title || p.titleAr || p.slug }),
      consequence: t('deleteConsequence'),
      confirmLabel: t('deleteConfirm'),
    });
    if (!ok) return;
    const { error } = await apiDelete(
      `/api/v1/stores/${storeId}/pages/${encodeURIComponent(p.slug)}`
    );
    if (error) {
      toastError(t('deleteError'));
      return;
    }
    toastSuccess(t('deleted'));
    await fetchPages();
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
        <Button type="button" onClick={handleNewPage} className="gap-2 font-semibold">
          {t('newPage')}
        </Button>
      }
    >
      <Modal
        isOpen={newPageOpen}
        onClose={() => setNewPageOpen(false)}
        title={t('newPageTitle')}
        size="md"
      >
        <form
          onSubmit={e => {
            e.preventDefault();
            submitNewPage();
          }}
        >
          <label className="block text-sm font-medium text-foreground">
            {t('newPageNameLabel')}
            <input
              value={newTitle}
              onChange={e => {
                setNewTitle(e.target.value);
                setNewSlugInvalid(false);
              }}
              dir="auto"
              autoFocus
              aria-invalid={newSlugInvalid}
              placeholder={t('newPageNamePlaceholder')}
              className="mt-1 w-full rounded-lg border border-border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </label>
          <details className="mt-3">
            <summary className="cursor-pointer text-sm text-muted-foreground">
              {t('newPageAdvanced')}
            </summary>
            <label className="mt-2 block text-sm font-medium text-foreground">
              {t('newPageSlugLabel')}
              <input
                value={newSlug}
                onChange={e => {
                  setNewSlug(e.target.value);
                  setNewSlugInvalid(false);
                }}
                dir="ltr"
                placeholder={slugFromTitle(newTitle)}
                className="mt-1 w-full rounded-lg border border-border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </label>
          </details>
          {newSlugInvalid && (
            <p role="alert" className="mt-2 text-sm text-destructive-ink">
              {t('newPageInvalid')}
            </p>
          )}
          <div className="mt-6 flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={() => setNewPageOpen(false)}>
              {t('newPageCancel')}
            </Button>
            <Button type="submit">{t('newPageConfirm')}</Button>
          </div>
        </form>
      </Modal>
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
                      deleteLabel={isProtectedPageSlug(p.slug) ? undefined : t('deletePage')}
                      onDelete={() => void handleDelete(p)}
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
  deleteLabel,
  onDelete,
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
  deleteLabel?: string;
  onDelete?: () => void;
}) {
  const authored = row ? hasContent(row) : false;
  const titleEn = row?.title?.trim() || defaultTitleEn;
  const titleAr = row?.titleAr?.trim() || defaultTitleAr;
  // The title in the admin's own language leads; the other language is the secondary line (audit S-5).
  const isAr = useLocale() === 'ar';
  const primaryTitle = isAr ? titleAr : titleEn;
  const secondaryTitle = isAr ? titleEn : titleAr;
  return (
    <div className="flex items-stretch gap-2">
      <Link
        href={`/stores/${storeId}/content/${encodeURIComponent(slug)}`}
        className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-accent/30"
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
                  : 'bg-warning/15 text-warning-ink'
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
      {deleteLabel && onDelete && (
        <Button type="button" variant="outline" onClick={onDelete} className="shrink-0 self-center">
          {deleteLabel}
        </Button>
      )}
    </div>
  );
}
