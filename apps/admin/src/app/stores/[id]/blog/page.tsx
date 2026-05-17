'use client';

import { useEffect, useState, use } from 'react';
import Link from 'next/link';
import { apiGet, apiDelete } from '../../../../lib/api';

interface BlogPost {
  id: string;
  slug: string;
  title: string;
  titleAr?: string | null;
  excerpt?: string | null;
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Blog</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Write articles, news, and stories that show up on your storefront blog.
          </p>
        </div>
        <Link
          href={`/stores/${storeId}/blog/new`}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
        >
          + New post
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
          <div className="p-10 text-center text-sm text-muted-foreground">Loading…</div>
        ) : posts.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm text-muted-foreground">No blog posts yet.</p>
            <Link
              href={`/stores/${storeId}/blog/new`}
              className="mt-3 inline-block text-sm font-semibold text-primary hover:underline"
            >
              Write your first post →
            </Link>
          </div>
        ) : (
          <ul className="divide-y">
            {posts.map(post => (
              <li
                key={post.id}
                className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-center gap-3 min-w-0">
                  {post.coverImage ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={post.coverImage}
                      alt=""
                      className="h-12 w-16 shrink-0 rounded object-cover"
                    />
                  ) : (
                    <div className="h-12 w-16 shrink-0 rounded bg-muted" />
                  )}
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">{post.title}</p>
                    <p className="text-xs text-muted-foreground">
                      /{post.slug} ·{' '}
                      {post.isPublished ? (
                        <span className="text-emerald-700">Published</span>
                      ) : (
                        <span className="text-amber-700">Draft</span>
                      )}{' '}
                      · {new Date(post.publishedAt ?? post.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Link
                    href={`/stores/${storeId}/blog/${post.id}`}
                    className="inline-flex items-center rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-muted"
                  >
                    Edit
                  </Link>
                  <button
                    type="button"
                    disabled={deletingId === post.id}
                    onClick={() => handleDelete(post.id)}
                    className="inline-flex items-center rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/10 disabled:opacity-60"
                  >
                    {deletingId === post.id ? 'Deleting…' : 'Delete'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
