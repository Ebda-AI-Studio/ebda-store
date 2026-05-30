'use client';

import Link from 'next/link';

interface BlogPost {
  id: string;
  slug: string;
  title: string;
  excerpt?: string;
  content: string;
  coverImage?: string;
  publishedAt?: string;
  author?: string;
  tags?: string[];
}

/**
 * Client leaf for the blog detail page. All interactive / presentational
 * rendering lives here; the parent `page.tsx` is a server component that fetches
 * the post once for SSR metadata + JSON-LD and passes it down (F2).
 */
export function BlogPostClient({ post }: { post: BlogPost | null }) {
  if (!post) return <div className="p-8 text-center">Post not found</div>;

  return (
    <article className="mx-auto max-w-3xl px-4 py-12">
      {post.coverImage && (
        <img src={post.coverImage} alt={post.title} className="mb-6 w-full rounded-lg" />
      )}
      <h1 className="text-3xl font-bold">{post.title}</h1>
      {post.author && <p className="mt-2 text-sm text-muted-foreground">By {post.author}</p>}
      <div className="prose mt-6 max-w-none" dangerouslySetInnerHTML={{ __html: post.content }} />
      {post.tags && post.tags.length > 0 && (
        <div className="mt-8 flex flex-wrap gap-2">
          {post.tags.map(t => (
            <span key={t} className="rounded bg-muted px-2 py-1 text-xs">
              {t}
            </span>
          ))}
        </div>
      )}
      <Link href="/blog" className="mt-8 inline-block text-primary underline">
        ← Back to blog
      </Link>
    </article>
  );
}
