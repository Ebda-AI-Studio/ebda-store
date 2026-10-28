'use client';

import { useStoreNumerals } from '../../../hooks/useNumerals';
import { intlLocale } from '@ebda/shared';
import Link from '../../../components/StoreLink';
import Image from 'next/image';
import { ShopChrome } from '../../../components';
import { useStoreUrl } from '../../../contexts/StoreContext';
import { useLanguage } from '../../../contexts/LanguageContext';
import { ShareProductRow } from '../../../templates/shared/ShareProductRow';

export interface BlogDetail {
  id: string;
  slug: string;
  title: string;
  titleAr?: string | null;
  excerpt?: string | null;
  excerptAr?: string | null;
  content: string;
  contentAr?: string | null;
  coverImage?: string | null;
  publishedAt?: string | null;
  createdAt: string;
}

/**
 * Client leaf for the blog detail page. The parent `page.tsx` is now a server
 * component that fetches the post once for SSR metadata + Article JSON-LD (F2)
 * and passes it down here for interactive / localized rendering.
 *
 * Body is rendered as paragraphs split on blank lines, each text node escaped
 * by React's default JSX handling — NO `dangerouslySetInnerHTML`. Merchants
 * supply plain text only, so the XSS surface stays at zero (unchanged from the
 * original client-only implementation).
 */
export function BlogPostClient({
  post,
  shareUrl,
}: {
  post: BlogDetail | null;
  /** Canonical post URL from the server, for the share row. */
  shareUrl?: string;
}) {
  const { isRtl } = useLanguage();
  const numerals = useStoreNumerals();
  const storeUrl = useStoreUrl();

  const body = post ? (isRtl && post.contentAr ? post.contentAr : post.content) : '';
  const paragraphs = body
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean);

  return (
    <ShopChrome>
      <article
        dir={isRtl ? 'rtl' : 'ltr'}
        className="bg-[hsl(var(--bg-page))] py-12 sm:py-16 lg:py-20"
      >
        <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
          {!post ? (
            <div className="text-center py-16">
              <p className="text-foreground/70">
                {isRtl ? 'المقال غير موجود.' : 'Post not found.'}
              </p>
              <Link
                href={storeUrl('/blog')}
                className="mt-3 inline-block text-sm font-semibold text-[hsl(var(--primary))] hover:underline"
              >
                {isRtl ? '← العودة للمدونة' : '← Back to blog'}
              </Link>
            </div>
          ) : (
            <>
              <header className="mb-8">
                <Link
                  href={storeUrl('/blog')}
                  prefetch={false}
                  className="text-sm font-semibold text-foreground/70 hover:text-foreground"
                >
                  {isRtl ? '← المدونة' : '← Blog'}
                </Link>
                <p className="mt-6 text-xs text-muted-foreground">
                  {new Date(post.publishedAt ?? post.createdAt).toLocaleDateString(
                    intlLocale(isRtl ? 'ar' : 'en', numerals),
                    { year: 'numeric', month: 'long', day: 'numeric' }
                  )}
                </p>
                <h1 className="mt-2 text-3xl sm:text-4xl font-bold text-foreground tracking-tight">
                  {isRtl && post.titleAr ? post.titleAr : post.title}
                </h1>
              </header>

              {post.coverImage && (
                <div className="relative aspect-[16/9] overflow-hidden rounded-lg bg-foreground/5 mb-8">
                  <Image
                    src={post.coverImage}
                    alt={isRtl && post.titleAr ? post.titleAr : post.title}
                    fill
                    sizes="(max-width: 1024px) 100vw, 768px"
                    priority
                    className="object-cover"
                  />
                </div>
              )}

              <div className="prose-blog space-y-5 text-base sm:text-lg text-foreground/85 leading-relaxed">
                {paragraphs.map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
              </div>

              <ShareProductRow
                productName={isRtl && post.titleAr ? post.titleAr : post.title}
                url={shareUrl}
                className="mt-10 border-t border-foreground/10 pt-6"
              />
            </>
          )}
        </div>
      </article>
    </ShopChrome>
  );
}
