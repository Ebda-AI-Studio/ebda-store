'use client';

import { useStoreNumerals } from '../../hooks/useNumerals';
import { intlLocale } from '@ebda/shared';
import Link from '../../components/StoreLink';
import Image from 'next/image';
import { ShopChrome } from '../../components';
import { useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';

export interface BlogListItem {
  id: string;
  slug: string;
  title: string;
  titleAr?: string | null;
  excerpt?: string | null;
  excerptAr?: string | null;
  coverImage?: string | null;
  publishedAt?: string | null;
  createdAt: string;
}

/**
 * Bucket E1 (2026-05-17) — public blog list page. Client leaf: the posts are fetched on the
 * SERVER (`BlogIndexBody`) and handed down, so the first paint is the real list (audit 2026-11-03
 * #7: the client fetch painted a loading line for ~1.5 s, then the grid pushed the footer down, CLS
 * 0.63, and crawlers saw an empty page).
 *
 * Renders all published posts for the store, newest first. Empty-state message when the merchant
 * hasn't published anything; "Blog not available" when the store hasn't opted in to blogEnabled
 * (the API returns 404 BLOG_DISABLED).
 */
export function BlogIndexClient({ posts, disabled }: { posts: BlogListItem[]; disabled: boolean }) {
  const { isRtl } = useLanguage();
  const numerals = useStoreNumerals();
  const storeUrl = useStoreUrl();

  return (
    <ShopChrome>
      <section
        dir={isRtl ? 'rtl' : 'ltr'}
        className="bg-[hsl(var(--bg-page))] py-12 sm:py-16 lg:py-20"
      >
        <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
          <header className="mb-8">
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[hsl(var(--accent-soft))]">
              {isRtl ? 'مقالات' : 'Stories'}
            </p>
            <h1 className="mt-1 text-3xl sm:text-4xl font-bold text-foreground tracking-tight">
              {isRtl ? 'المدونة' : 'Blog'}
            </h1>
          </header>

          {disabled ? (
            <p className="text-center text-sm text-foreground/70 py-16">
              {isRtl ? 'المدونة مش متاحة دلوقتي.' : 'Blog is not available right now.'}
            </p>
          ) : posts.length === 0 ? (
            <p className="text-center text-sm text-foreground/70 py-16">
              {isRtl ? 'مفيش مقالات لسه.' : 'No posts yet.'}
            </p>
          ) : (
            <ul className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {posts.map(post => {
                const title = isRtl && post.titleAr ? post.titleAr : post.title;
                const excerpt = isRtl && post.excerptAr ? post.excerptAr : post.excerpt;
                const date = post.publishedAt ?? post.createdAt;
                return (
                  <li key={post.id}>
                    <Link
                      href={storeUrl(`/blog/${post.slug}`)}
                      prefetch={false}
                      className="group block rounded-lg overflow-hidden bg-[hsl(var(--bg-card))] transition-shadow hover:shadow-[0_18px_40px_-20px_hsl(var(--foreground)/0.15)]"
                    >
                      <div className="relative aspect-[4/3] overflow-hidden bg-foreground/5">
                        {post.coverImage ? (
                          <Image
                            src={post.coverImage}
                            alt={title}
                            fill
                            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
                            loading="lazy"
                            className="object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                          />
                        ) : null}
                      </div>
                      <div className="p-4">
                        <p className="text-xs text-muted-foreground">
                          {new Date(date).toLocaleDateString(
                            intlLocale(isRtl ? 'ar' : 'en', numerals),
                            {
                              year: 'numeric',
                              month: 'short',
                              day: 'numeric',
                            }
                          )}
                        </p>
                        <h2 className="mt-1 text-lg font-bold text-foreground line-clamp-2">
                          {title}
                        </h2>
                        {excerpt && (
                          <p className="mt-2 text-sm text-foreground/70 line-clamp-3">{excerpt}</p>
                        )}
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    </ShopChrome>
  );
}
