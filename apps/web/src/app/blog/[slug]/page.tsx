'use client';

import { useEffect, useState, use } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { ShopChrome } from '../../../components';
import { useStore, useStoreUrl } from '../../../contexts/StoreContext';
import { useLanguage } from '../../../contexts/LanguageContext';
import { ShareProductRow } from '../../../templates/shared/ShareProductRow';
import { api } from '../../../lib/api';

interface BlogDetail {
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
 * Bucket E1 (2026-05-17) — public blog post detail.
 *
 * Content is rendered as paragraphs split on `\n\n`, each text node
 * escaped (React's default JSX text handling). No HTML / Markdown is
 * accepted from merchants for v1 — keeps the XSS surface at zero.
 *
 * Reuses ShareProductRow for share buttons (X/FB/Telegram/WhatsApp/
 * copy-link) since the visual + behavior are identical for blog posts.
 */
export default function BlogPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const { store } = useStore();
  const { isRtl } = useLanguage();
  const storeUrl = useStoreUrl();
  const [post, setPost] = useState<BlogDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setIsLoading(true);
      const res = await api.getBlogPost(store.id, slug);
      if (cancelled) return;
      if (res.success && res.data?.post) {
        setPost(res.data.post);
      } else {
        setNotFound(true);
      }
      setIsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [store.id, slug]);

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
          {isLoading ? (
            <p className="text-center text-sm text-foreground/60 py-16">
              {isRtl ? 'جارٍ التحميل…' : 'Loading…'}
            </p>
          ) : notFound || !post ? (
            <div className="text-center py-16">
              <p className="text-foreground/60">
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
                  className="text-sm font-semibold text-foreground/60 hover:text-foreground"
                >
                  {isRtl ? '← المدونة' : '← Blog'}
                </Link>
                <p className="mt-6 text-xs text-foreground/55">
                  {new Date(post.publishedAt ?? post.createdAt).toLocaleDateString(
                    isRtl ? 'ar-KW' : 'en-KW',
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
                url={typeof window !== 'undefined' ? window.location.href : ''}
                className="mt-10 border-t border-foreground/10 pt-6"
              />
            </>
          )}
        </div>
      </article>
    </ShopChrome>
  );
}
