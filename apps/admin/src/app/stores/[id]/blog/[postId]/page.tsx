'use client';

import { useEffect, useState, use } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { apiGet, apiPost, apiPut } from '../../../../../lib/api';
import { ImageUpload } from '../../../../../components/ImageUpload';

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
      setError('Title, slug, and content are required.');
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
    router.push(`/stores/${storeId}/blog`);
  }

  if (isLoading) {
    return <div className="p-10 text-center text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">
            {isNew ? 'New blog post' : 'Edit blog post'}
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Write a story or article that customers see on your storefront blog.
          </p>
        </div>
        <Link
          href={`/stores/${storeId}/blog`}
          className="text-sm font-semibold text-muted-foreground hover:text-foreground"
        >
          ← Back to all posts
        </Link>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6 rounded-xl border bg-card p-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium text-foreground">
              Title (English) <span className="text-destructive">*</span>
            </label>
            <input
              type="text"
              value={form.title}
              onChange={e => update('title', e.target.value)}
              className="w-full rounded-lg border border-border px-4 py-2 text-base sm:text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder="What's new at your store..."
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-foreground">Title (Arabic)</label>
            <input
              type="text"
              lang="ar"
              dir="rtl"
              value={form.titleAr}
              onChange={e => update('titleAr', e.target.value)}
              className="w-full rounded-lg border border-border px-4 py-2 text-base sm:text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder="ما الجديد في متجرك..."
            />
          </div>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-foreground">
            URL slug <span className="text-destructive">*</span>
          </label>
          <input
            type="text"
            value={form.slug}
            onChange={e => update('slug', slugify(e.target.value))}
            className="w-full rounded-lg border border-border px-4 py-2 font-mono text-base sm:text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder="my-first-post"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Lowercase letters, numbers, and dashes. Used in the public URL: /blog/
            {form.slug || '<slug>'}
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium text-foreground">
              Excerpt (English)
            </label>
            <textarea
              value={form.excerpt}
              onChange={e => update('excerpt', e.target.value)}
              rows={3}
              className="w-full resize-none rounded-lg border border-border px-4 py-2 text-base sm:text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder="One or two sentences shown on the blog list..."
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-foreground">
              Excerpt (Arabic)
            </label>
            <textarea
              lang="ar"
              dir="rtl"
              value={form.excerptAr}
              onChange={e => update('excerptAr', e.target.value)}
              rows={3}
              className="w-full resize-none rounded-lg border border-border px-4 py-2 text-base sm:text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder="جملة أو اثنتان تظهران في قائمة المدونة..."
            />
          </div>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-foreground">Cover image</label>
          <ImageUpload
            value={form.coverImage || undefined}
            onUpload={url => update('coverImage', url)}
            onRemove={() => update('coverImage', '')}
            folder="pages"
            storeId={storeId}
            label="Upload cover image"
            aspectRatio="3/2"
            recommendedSizeHint="Recommended: 1200×800px (3:2 landscape)"
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium text-foreground">
              Content (English) <span className="text-destructive">*</span>
            </label>
            <textarea
              value={form.content}
              onChange={e => update('content', e.target.value)}
              rows={14}
              className="w-full rounded-lg border border-border px-4 py-2 text-base sm:text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder="Write your story here. Use a blank line to start a new paragraph."
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-foreground">
              Content (Arabic)
            </label>
            <textarea
              lang="ar"
              dir="rtl"
              value={form.contentAr}
              onChange={e => update('contentAr', e.target.value)}
              rows={14}
              className="w-full rounded-lg border border-border px-4 py-2 text-base sm:text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder="اكتب قصتك هنا. اترك سطرًا فارغًا لبدء فقرة جديدة."
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
            <span className="block font-semibold text-foreground">Publish to storefront</span>
            <span className="block text-xs text-muted-foreground">
              When checked, this post is visible at /blog/{form.slug || '<slug>'} on your store.
              Uncheck to keep as a draft.
            </span>
          </span>
        </label>

        {error && (
          <p className="rounded-lg bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</p>
        )}

        <div className="flex items-center justify-end gap-3 border-t pt-6">
          <Link
            href={`/stores/${storeId}/blog`}
            className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-foreground hover:bg-muted"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={isSaving}
            className="rounded-lg bg-primary px-6 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            {isSaving ? 'Saving…' : isNew ? 'Create post' : 'Save changes'}
          </button>
        </div>
      </form>
    </div>
  );
}
