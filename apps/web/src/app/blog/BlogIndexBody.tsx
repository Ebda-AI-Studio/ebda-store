import type { ResolvedStore } from '../../lib/store-resolver';
import { API_URL } from '../../lib/api';
import { BlogIndexClient, type BlogListItem } from './BlogIndexClient';

/**
 * Blog index, rendered on the server (audit 2026-11-03 #7). Shared by `app/blog/page.tsx`
 * (header-resolved) and `app/tenant-store/[tenant]/[locale]/blog/page.tsx` (params-resolved), like
 * `BlogPostBody`.
 *
 * `/public/:storeId/blog` answers 404 BLOG_DISABLED / NOT_FOUND when the store has the blog off:
 * that is a definitive "not available" state, rendered, not an error. A transient failure (5xx or a
 * network error) THROWS so the page 500s instead of being cached for 60 s as a false empty list.
 */
export async function fetchBlogPosts(
  storeId: string,
  limit = 50
): Promise<{ posts: BlogListItem[]; disabled: boolean }> {
  if (!storeId || storeId === 'demo') return { posts: [], disabled: false };
  const res = await fetch(`${API_URL}/public/${storeId}/blog?limit=${limit}`, {
    next: { revalidate: 60 },
  });
  if (res.status === 404) return { posts: [], disabled: true };
  if (!res.ok) throw new Error(`blog list fetch failed: ${res.status}`);
  const json = await res.json();
  const posts = (json?.data?.posts ?? []) as BlogListItem[];
  return { posts: Array.isArray(posts) ? posts : [], disabled: false };
}

export async function BlogIndexBody({ store }: { store: ResolvedStore }) {
  const { posts, disabled } = await fetchBlogPosts(store.id);
  return <BlogIndexClient posts={posts} disabled={disabled} />;
}
