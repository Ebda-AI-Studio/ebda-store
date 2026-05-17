'use client';

import Link from 'next/link';
import Image from 'next/image';
import { useLanguage } from '../../contexts/LanguageContext';
import { useStoreUrl } from '../../contexts/StoreContext';

export interface BlogCarouselPost {
  id: string;
  slug: string;
  title: string;
  titleAr?: string | null;
  excerpt?: string | null;
  excerptAr?: string | null;
  coverImage?: string | null;
  publishedAt?: string | null;
  createdAt?: string;
}

interface BlogCarouselProps {
  posts: BlogCarouselPost[];
}

/**
 * Bucket E1 (2026-05-17): horizontal blog post strip on the homepage.
 * Auto-hides when there are no posts. Mirrors the SMEJ "المدونة"
 * section observed in the 2026-05-17 UI catalog: horizontal scroll
 * cards with image / date / title / "قراءة المزيد" link.
 *
 * Section background uses `--bg-page` so it alternates with the
 * Trust strip / Brand story / footer rhythm above and below.
 */
export function BlogCarousel({ posts }: BlogCarouselProps) {
  const { isRtl } = useLanguage();
  const storeUrl = useStoreUrl();
  if (!posts || posts.length === 0) return null;

  return (
    <section
      aria-label={isRtl ? 'المدونة' : 'Blog'}
      dir={isRtl ? 'rtl' : 'ltr'}
      className="bg-[hsl(var(--bg-page))] py-12 sm:py-16 lg:py-20"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="mb-6 flex items-end justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[hsl(var(--accent-soft))]">
              {isRtl ? 'مقالات' : 'Stories'}
            </p>
            <h2 className="mt-1 text-2xl sm:text-3xl font-bold text-foreground tracking-tight">
              {isRtl ? 'من المدونة' : 'From the Blog'}
            </h2>
          </div>
          <Link
            href={storeUrl('/blog')}
            className="text-sm font-semibold text-[hsl(var(--primary))] hover:underline"
          >
            {isRtl ? 'عرض كل المقالات' : 'View all'}
          </Link>
        </div>

        <ul className="-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto overscroll-x-contain px-4 pb-4 sm:gap-6">
          {posts.map(post => {
            const title = isRtl && post.titleAr ? post.titleAr : post.title;
            const excerpt = isRtl && post.excerptAr ? post.excerptAr : post.excerpt;
            const date = post.publishedAt ?? post.createdAt;
            return (
              <li
                key={post.id}
                className="snap-start shrink-0 w-[78vw] sm:w-[48vw] md:w-[32vw] lg:w-[24vw]"
              >
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
                        sizes="(max-width: 640px) 78vw, (max-width: 1024px) 48vw, 24vw"
                        loading="lazy"
                        className="object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                      />
                    ) : null}
                  </div>
                  <div className="p-4">
                    {date && (
                      <p className="text-xs text-foreground/55">
                        {new Date(date).toLocaleDateString(isRtl ? 'ar-KW' : 'en-KW', {
                          year: 'numeric',
                          month: 'short',
                          day: 'numeric',
                        })}
                      </p>
                    )}
                    <h3 className="mt-1 text-base font-bold text-foreground line-clamp-2">
                      {title}
                    </h3>
                    {excerpt && (
                      <p className="mt-2 text-sm text-foreground/65 line-clamp-2">{excerpt}</p>
                    )}
                    <p className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-[hsl(var(--primary))]">
                      {isRtl ? 'قراءة المزيد' : 'Read more'}
                      <svg
                        className="h-3.5 w-3.5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        aria-hidden
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d={isRtl ? 'M10 19l-7-7m0 0l7-7m-7 7h18' : 'M14 5l7 7m0 0l-7 7m7-7H3'}
                        />
                      </svg>
                    </p>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
