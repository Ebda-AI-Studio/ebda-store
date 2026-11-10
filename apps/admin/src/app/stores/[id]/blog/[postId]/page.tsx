'use client';

import { useEffect, useState, use } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { recommendedSizeText } from '@ebda/shared';
import { apiGet, apiPost, apiPut } from '../../../../../lib/api';
import { ImageUpload } from '../../../../../components/ImageUpload';
import { AdminLayout } from '../../../../../components/AdminLayout';
import { AdminSkeletonDetail } from '../../../../../components/AdminSkeleton';
import { useT } from '@/i18n/useT';
import { Button, buttonVariants } from '@/components/ui/Button';

interface BlogPost {
  id: string;
  storeId: string;
  slug: string;
  title: string;
  titleAr?: string | null;
  excerpt?: string | null;
  excerptAr?: string | null;
  content: string;
  contentAr?: string | null;
  coverImage?: string | null;
  isPublished: boolean;
  publishedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface BlogFormData {
  slug: string;
  title: string;
  titleAr: string;
  excerpt: string;
  excerptAr: string;
  content: string;
  contentAr: string;
  coverImage: string;
  isPublished: boolean;
}

function emptyForm(): BlogFormData {
  return {
    slug: '',
    title: '',
    titleAr: '',
    excerpt: '',
    excerptAr: '',
    content: '',
    contentAr: '',
    coverImage: '',
    isPublished: false,
  };
}

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80);
}

/**
 * Bucket E1 (2026-05-17) — single admin form for both new + edit blog posts.
 * Route /stores/[id]/blog/[postId] where postId === 'new' triggers create mode.
 */
export default function BlogPostEditorPage({
  params,
}: {
  params: Promise<{ id: string; postId: string }>;
}) {
  const { id: storeId, postId } = use(params);
  const isNew = postId === 'new';
  const router = useRouter();
  const [form, setForm] = useState<BlogFormData>(emptyForm);
  const [isLoading, setIsLoading] = useState(!isNew);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = useT('blog.editor');

  useEffect(() => {
    if (isNew) {
      setIsLoading(false);
      return;
    }
    (async () => {
      setIsLoading(true);
      const { data, error } = await apiGet<{ post: BlogPost }>(
        `/api/v1/stores/${storeId}/blog/${postId}`
      );
      if (data?.post) {
        const p = data.post;
        setForm({
          slug: p.slug,
          title: p.title,
          titleAr: p.titleAr ?? '',
          excerpt: p.excerpt ?? '',
          excerptAr: p.excerptAr ?? '',
          content: p.content,
          contentAr: p.contentAr ?? '',
          coverImage: p.coverImage ?? '',
          isPublished: p.isPublished,
        });
      } else if (error) {
        setError(error.message);
      }
      setIsLoading(false);
    })();
  }, [isNew, storeId, postId]);

  function update<K extends keyof BlogFormData>(key: K, value: BlogFormData[K]) {
    setForm(prev => {
      const next = { ...prev, [key]: value };
      // Auto-derive slug from title only on create + when slug is empty
      if (isNew && key === 'title' && !prev.slug) {
        next.slug = slugify(value as string);
      }
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!form.title.trim() || !form.content.trim() || !form.slug.trim()) {
      setError(t('validationError'));
      return;
    }
    setIsSaving(true);
    const payload = {
      ...form,
      titleAr: form.titleAr || null,
      excerpt: form.excerpt || null,
      excerptAr: form.excerptAr || null,
      contentAr: form.contentAr || null,
      coverImage: form.coverImage || null,
    };
    const url = isNew
      ? `/api/v1/stores/${storeId}/blog`
      : `/api/v1/stores/${storeId}/blog/${postId}`;
    const { error } = isNew ? await apiPost(url, payload) : await apiPut(url, payload);
    setIsSaving(false);
    if (error) {
      setError(error.message);
      return;
    }
    // invalidate App Router cache so the destination list re-fetches the saved row
    router.refresh();
    router.push(`/stores/${storeId}/blog`);
  }

  // The editor renders inside <AdminLayout> like every other store page —
  // loading included. It used to render bare (no sidebar, hub tabs or
  // topbar at all), the same chrome-dropping class as audit 2026-09-30 §8.
  return (
    <AdminLayout
      title={isNew ? t('newTitle') : t('editTitle')}
      subtitle={t('subtitle')}
      actions={
        <Link
          href={`/stores/${storeId}/blog`}
          className="text-sm font-semibold text-muted-foreground hover:text-foreground"
        >
          {t('backToAll')}
        </Link>
      }
    >
      {isLoading ? (
        <AdminSkeletonDetail showHeader={false} />
      ) : (
        <form onSubmit={handleSubmit} className="space-y-6 rounded-xl border bg-card p-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium text-foreground">
                {t('titleEn')} <span className="text-destructive-ink">*</span>
              </label>
              <input
                type="text"
                value={form.title}
                onChange={e => update('title', e.target.value)}
                className="w-full rounded-lg border border-input px-4 py-2 text-base sm:text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                placeholder={t('titleEnPlaceholder')}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-foreground">
                {t('titleAr')}
              </label>
              <input
                type="text"
                lang="ar"
                dir="rtl"
                value={form.titleAr}
                onChange={e => update('titleAr', e.target.value)}
                className="w-full rounded-lg border border-input px-4 py-2 text-base sm:text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                placeholder={t('titleArPlaceholder')}
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-foreground">
              {t('slug')} <span className="text-destructive-ink">*</span>
            </label>
            <input
              type="text"
              value={form.slug}
              onChange={e => update('slug', slugify(e.target.value))}
              className="w-full rounded-lg border border-input px-4 py-2 font-mono text-base sm:text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder={t('slugPlaceholder')}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {t('slugHint', { slug: form.slug || '<slug>' })}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium text-foreground">
                {t('excerptEn')}
              </label>
              <textarea
                value={form.excerpt}
                onChange={e => update('excerpt', e.target.value)}
                rows={3}
                className="w-full resize-none rounded-lg border border-input px-4 py-2 text-base sm:text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                placeholder={t('excerptEnPlaceholder')}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-foreground">
                {t('excerptAr')}
              </label>
              <textarea
                lang="ar"
                dir="rtl"
                value={form.excerptAr}
                onChange={e => update('excerptAr', e.target.value)}
                rows={3}
                className="w-full resize-none rounded-lg border border-input px-4 py-2 text-base sm:text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                placeholder={t('excerptArPlaceholder')}
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-foreground">
              {t('coverImage')}
            </label>
            <ImageUpload
              value={form.coverImage || undefined}
              onUpload={url => update('coverImage', url)}
              onRemove={() => update('coverImage', '')}
              folder="pages"
              storeId={storeId}
              label={t('coverImageUpload')}
              aspectRatio="3/2"
              recommendedSizeHint={recommendedSizeText('blogCover')}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium text-foreground">
                {t('contentEn')} <span className="text-destructive-ink">*</span>
              </label>
              <textarea
                value={form.content}
                onChange={e => update('content', e.target.value)}
                rows={14}
                className="w-full rounded-lg border border-input px-4 py-2 text-base sm:text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                placeholder={t('contentEnPlaceholder')}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-foreground">
                {t('contentAr')}
              </label>
              <textarea
                lang="ar"
                dir="rtl"
                value={form.contentAr}
                onChange={e => update('contentAr', e.target.value)}
                rows={14}
                className="w-full rounded-lg border border-input px-4 py-2 text-base sm:text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                placeholder={t('bodyArPlaceholder')}
              />
            </div>
          </div>

          <label className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 p-4">
            <input
              type="checkbox"
              checked={form.isPublished}
              onChange={e => update('isPublished', e.target.checked)}
              className="h-5 w-5 cursor-pointer accent-primary"
            />
            <span className="text-sm">
              <span className="block font-semibold text-foreground">{t('publishLabel')}</span>
              <span className="block text-xs text-muted-foreground">
                {t('publishHint', { slug: form.slug || '<slug>' })}
              </span>
            </span>
          </label>

          {error && (
            <p className="rounded-lg bg-destructive/10 px-4 py-2 text-sm text-destructive-ink">
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-3 border-t pt-6">
            <Link
              href={`/stores/${storeId}/blog`}
              className={buttonVariants({ variant: 'outline' })}
            >
              {t('cancel')}
            </Link>
            <Button variant="default" size="md" type="submit" disabled={isSaving}>
              {isSaving ? t('saving') : isNew ? t('createPost') : t('saveChanges')}
            </Button>
          </div>
        </form>
      )}
    </AdminLayout>
  );
}
