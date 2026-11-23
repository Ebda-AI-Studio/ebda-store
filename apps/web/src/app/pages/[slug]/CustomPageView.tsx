'use client';

import Image from 'next/image';
import { useLanguage } from '../../../contexts/LanguageContext';
import type { PublicCustomPage } from '../../../lib/custom-page';

/** A merchant's custom page: title + the API-rendered, HTML-escaped body, in the shopper's language (the other as fallback). */
export function CustomPageView({ page }: { page: PublicCustomPage }) {
  const { language } = useLanguage();
  const ar = language === 'ar';
  const html =
    (ar ? page.contentHtmlAr || page.contentHtml : page.contentHtml || page.contentHtmlAr) ?? '';
  const title = (ar ? page.titleAr || page.title : page.title || page.titleAr) || page.slug;
  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6 lg:px-8">
      {page.coverImage && (
        <div className="relative mb-8 aspect-[3/1] w-full overflow-hidden rounded-xl bg-muted">
          <Image
            src={page.coverImage}
            alt={title}
            fill
            sizes="(max-width: 768px) 100vw, 768px"
            className="object-cover"
            unoptimized
          />
        </div>
      )}
      <h1 className="text-center text-3xl font-bold text-foreground">{title}</h1>
      <div className="mt-12 rounded-xl border bg-card p-6 shadow-sm sm:p-8">
        {/* The API renders the blocks to HTML and escapes every text input (renderBlocksToHtml), like CmsPageContent. */}
        <div
          className="cms-markdown prose prose-gray max-w-none text-muted-foreground"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  );
}
