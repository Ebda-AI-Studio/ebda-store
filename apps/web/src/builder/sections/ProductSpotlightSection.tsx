'use client';

/**
 * `product-spotlight` (builder Phase 3 pilot, document-only): one editorial
 * photograph beside a short list of products ("Gift ideas"). The image side
 * is logical (start = right in Arabic). Products resolve like the grids.
 */
import React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import type { SectionPaddingMaxWidthVisibility } from '@force/shared';
import { sanitizeUrl } from '@force/shared';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { useLocalePrice } from '../../hooks/useLocalePrice';
import { sectionBgStyle } from '../../templates/shared/section-bg';
import { sectionSpacingClasses } from '../../templates/shared/section-spacing';
import { getProductPricing } from '../../lib/product-pricing';
import type { TemplateProduct } from '../../templates/types';
import type { SectionProductRefs } from './section-products';

export interface ProductSpotlightSettings
  extends SectionPaddingMaxWidthVisibility, SectionProductRefs {
  image?: string;
  imageAr?: string;
  alt?: string;
  altAr?: string;
  heading?: string;
  headingAr?: string;
  body?: string;
  bodyAr?: string;
  imagePosition?: 'start' | 'end';
  buttonText?: string;
  buttonTextAr?: string;
  buttonLink?: string;
  bgColor?: string;
}

export function ProductSpotlightSection({
  settings,
  products,
  editorMode = false,
}: {
  settings: ProductSpotlightSettings;
  products: TemplateProduct[];
  editorMode?: boolean;
}) {
  const { store } = useStore();
  const { language, t } = useLanguage();
  const storeUrl = useStoreUrl();
  const formatPrice = useLocalePrice();
  const ar = language === 'ar';
  const pick = (en?: string, a?: string) => (ar ? a || en : en || a) || '';
  const edit = (key: string): Record<string, string> | undefined =>
    editorMode ? { 'data-builder-setting': ar ? `${key}Ar` : key } : undefined;
  const spacing = sectionSpacingClasses(settings);
  const heading = pick(settings.heading, settings.headingAr);
  const body = pick(settings.body, settings.bodyAr);
  const image = pick(settings.image, settings.imageAr);
  const button = pick(settings.buttonText, settings.buttonTextAr);
  const imageFirst = (settings.imagePosition ?? 'start') === 'start';
  if (!image && products.length === 0) return null;

  return (
    <section
      data-section="product-spotlight"
      className={`bg-[hsl(var(--bg-section-alt))] ${spacing.wrapperClass}`}
      style={sectionBgStyle(settings.bgColor, store.theme)}
    >
      <div
        className={`${spacing.innerContainerClass} grid items-center gap-8 md:grid-cols-12 md:gap-12`}
      >
        {image && (
          <div
            className={`relative aspect-[4/5] overflow-hidden rounded-[var(--radius)] md:col-span-6 ${imageFirst ? 'md:order-1' : 'md:order-2'}`}
          >
            <Image
              src={image}
              alt={pick(settings.alt, settings.altAr)}
              fill
              sizes="(min-width: 768px) 50vw, 100vw"
              className="object-cover"
            />
          </div>
        )}
        <div
          className={`md:col-span-6 ${image ? (imageFirst ? 'md:order-2' : 'md:order-1') : 'md:col-span-12'}`}
        >
          {heading && (
            <h2
              className="font-display text-balance text-[clamp(1.6rem,1.15rem+1.5vw,2.5rem)] leading-tight text-foreground rtl:leading-[1.45]"
              {...edit('heading')}
            >
              {heading}
            </h2>
          )}
          {body && (
            <p
              className="mt-3 max-w-[48ch] text-pretty text-[15px] leading-relaxed text-muted-foreground"
              {...edit('body')}
            >
              {body}
            </p>
          )}
          {products.length > 0 && (
            <ul className="mt-8 divide-y divide-border border-y border-border">
              {products.map(p => {
                const name = (ar && p.nameAr ? p.nameAr : p.name) || '';
                const pricing = getProductPricing(p, undefined, 'card');
                return (
                  <li key={p.id}>
                    <Link
                      href={storeUrl(`/products/${p.slug}`)}
                      className="group/row flex items-center gap-4 py-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="relative aspect-[4/5] w-16 shrink-0 overflow-hidden rounded-[var(--radius)] bg-card">
                        {p.images?.[0]?.url && (
                          <Image
                            src={p.images[0].url}
                            alt=""
                            fill
                            sizes="64px"
                            className="object-cover"
                          />
                        )}
                      </span>
                      <span className="min-w-0 flex-1 text-[15px] leading-snug text-foreground transition-colors group-hover/row:text-primary">
                        {name}
                      </span>
                      <span className="shrink-0 text-[15px] tabular-nums text-primary">
                        {pricing.mode === 'fromMin' ? `${t('From', 'من')} ` : ''}
                        {formatPrice(pricing.displayPrice)}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
          {button && (
            <Link
              href={storeUrl(sanitizeUrl(settings.buttonLink, '/products'))}
              className="mt-8 inline-flex min-h-[48px] items-center justify-center rounded-[var(--radius)] border border-primary/70 px-7 text-sm font-medium text-primary transition-colors hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              {...edit('buttonText')}
            >
              {button}
            </Link>
          )}
        </div>
      </div>
    </section>
  );
}
