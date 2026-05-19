'use client';

import { useEffect, useMemo, useState, use } from 'react';
import Link from 'next/link';
import { apiGet, apiDelete } from '../../../../lib/api';

interface BlogPost {
  id: string;
  slug: string;
  title: string;
  titleAr?: string | null;
  excerpt?: string | null;
  excerptAr?: string | null;
  coverImage?: string | null;
  isPublished: boolean;
  publishedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface StoreInfo {
  blogEnabled?: boolean;
}

/**
 * Bucket E1 (2026-05-17) — admin blog list page.
 *
 * Lists all posts (drafts + published) newest first. Header shows the
 * store's `blogEnabled` state — if disabled, surfaces a callout linking
 * to the Branding tab where the toggle lives.
 */
export default function BlogListPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: storeId } = use(params);
  const [posts, setPosts] = useState<BlogPost[]>([]);
  const [store, setStore] = useState<StoreInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setIsLoading(true);
      const [postsRes, storeRes] = await Promise.all([
        apiGet<{ posts: BlogPost[] }>(`/api/v1/stores/${storeId}/blog`),
        apiGet<{ store: StoreInfo }>(`/api/v1/stores/${storeId}`),
      ]);
      if (cancelled) return;
      // Tolerate 404 on posts list (route exists but returns BLOG_DISABLED
      // when toggle is off) — list stays empty, header callout drives
      // merchant to enable it.
      if (postsRes.data?.posts) setPosts(postsRes.data.posts);
      if (storeRes.data?.store) setStore(storeRes.data.store);
      setIsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [storeId]);

  const { publishedCount, draftCount } = useMemo(() => {
    let p = 0;
    let d = 0;
    for (const post of posts) post.isPublished ? p++ : d++;
    return { publishedCount: p, draftCount: d };
  }, [posts]);

  async function handleDelete(postId: string) {
    if (!confirm('Delete this blog post? This cannot be undone.')) return;
    setDeletingId(postId);
    const { error } = await apiDelete(`/api/v1/stores/${storeId}/blog/${postId}`);
    setDeletingId(null);
    if (!error) {
      setPosts(prev => prev.filter(p => p.id !== postId));
    } else {
      alert(error.message || 'Delete failed');
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/stores/${storeId}`}
          className="inline-flex items-center gap-1 text-sm font-semibold text-muted-foreground hover:text-foreground"
        >
          ← Back to store
        </Link>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-5 w-5"
              aria-hidden
            >
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold text-foreground">Blog</h1>
              {!isLoading && posts.length > 0 && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                  <span className="text-emerald-700">{publishedCount} published</span>
                  <span aria-hidden>·</span>
                  <span className="text-amber-700">
                    {draftCount} draft{draftCount === 1 ? '' : 's'}
                  </span>
                </span>
              )}
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Write articles, news, and stories that show up on your storefront blog.
            </p>
          </div>
        </div>
        <Link
          href={`/stores/${storeId}/blog/new`}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4"
            aria-hidden
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New post
        </Link>
      </div>

      {store && store.blogEnabled === false && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          <p className="font-semibold text-amber-900">Blog is currently disabled</p>
          <p className="mt-1 text-amber-800">
            Your blog isn&apos;t visible on the storefront yet. Posts you create here are saved as
            drafts.{' '}
            <Link href={`/stores/${storeId}/branding`} className="font-semibold underline">
              Enable it in Branding
            </Link>{' '}
            to publish.
          </p>
        </div>
      )}

      <div className="rounded-xl border bg-card">
        {isLoading ? (
          <ul className="divide-y">
            {Array.from({ length: 3 }).map((_, i) => (
              <li key={i} className="flex items-center gap-3 p-4 animate-pulse">
                <div className="h-16 w-20 shrink-0 rounded bg-muted" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-1/2 rounded bg-muted" />
                  <div className="h-3 w-1/3 rounded bg-muted" />
                </div>
                <div className="hidden h-7 w-16 shrink-0 rounded bg-muted sm:block" />
              </li>
            ))}
          </ul>
        ) : posts.length === 0 ? (
          <div className="p-10 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-6 w-6"
                aria-hidden
              >
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              </svg>
            </div>
            <p className="text-base font-semibold text-foreground">No blog posts yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Articles, news, and stories you publish will show up here.
            </p>
            <Link
              href={`/stores/${storeId}/blog/new`}
              className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
            >
              Write your first post →
            </Link>
          </div>
        ) : (
          <ul className="divide-y">
            {posts.map(post => {
              const excerpt = post.excerpt || post.excerptAr;
              return (
                <li
                  key={post.id}
                  className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <Link
                    href={`/stores/${storeId}/blog/${post.id}`}
                    className="flex flex-1 items-start gap-3 min-w-0 group"
                  >
                    {post.coverImage ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={post.coverImage}
                        alt=""
                        className="h-16 w-20 shrink-0 rounded-lg object-cover sm:h-14 sm:w-20"
                      />
                    ) : (
                      <div className="flex h-16 w-20 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground sm:h-14 sm:w-20">
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={1.5}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="h-6 w-6 opacity-60"
                          aria-hidden
                        >
                          <rect x="3" y="3" width="18" height="18" rx="2" />
                          <circle cx="9" cy="9" r="2" />
                          <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
                        </svg>
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-semibold text-foreground group-hover:text-primary">
                          {post.title}
                        </p>
                        <span
                          className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                            post.isPublished
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-amber-100 text-amber-800'
                          }`}
                        >
                          {post.isPublished ? 'Published' : 'Draft'}
                        </span>
                      </div>
                      {post.titleAr && (
                        <p className="mt-0.5 truncate text-xs text-muted-foreground" dir="rtl">
                          {post.titleAr}
                        </p>
                      )}
                      {excerpt && (
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{excerpt}</p>
                      )}
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        /{post.slug} ·{' '}
                        {new Date(post.publishedAt ?? post.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                  </Link>
                  <div className="flex items-center gap-2 sm:shrink-0">
                    <Link
                      href={`/stores/${storeId}/blog/${post.id}`}
                      className="inline-flex flex-1 items-center justify-center rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-muted sm:flex-none"
                    >
                      Edit
                    </Link>
                    <button
                      type="button"
                      disabled={deletingId === post.id}
                      onClick={() => handleDelete(post.id)}
                      className="inline-flex items-center justify-center rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/10 disabled:opacity-60"
                    >
                      {deletingId === post.id ? 'Deleting…' : 'Delete'}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
