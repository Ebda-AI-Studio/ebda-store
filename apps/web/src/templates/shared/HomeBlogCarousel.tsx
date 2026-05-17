'use client';

import { useEffect, useState } from 'react';
import { BlogCarousel, type BlogCarouselPost } from './BlogCarousel';
import { useStore } from '../../contexts/StoreContext';
import { api } from '../../lib/api';

/**
 * Homepage container for the blog carousel — fetches posts client-side
 * after mount, gated on `store.blogEnabled`. Returns null when:
 *  - the store hasn't opted in to the blog feature
 *  - the fetch failed
 *  - there are no published posts
 * so the homepage stays clean for stores that haven't started blogging.
 *
 * Server-side prefetch could land later via page.tsx; client-side keeps
 * the section non-blocking on first render.
 */
export function HomeBlogCarousel() {
  const { store } = useStore();
  const [posts, setPosts] = useState<BlogCarouselPost[] | null>(null);

  useEffect(() => {
    if (!store.blogEnabled) return;
    let cancelled = false;
    (async () => {
      const res = await api.listBlogPosts(store.id, 8);
      if (cancelled) return;
      if (res.success && res.data?.posts) {
        setPosts(res.data.posts);
      } else {
        setPosts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [store.id, store.blogEnabled]);

  if (!store.blogEnabled) return null;
  if (!posts || posts.length === 0) return null;
  return <BlogCarousel posts={posts} />;
}
