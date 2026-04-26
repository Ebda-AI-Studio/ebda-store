'use client';

import Image from 'next/image';
import Link from 'next/link';
import { SectionHeading } from './SectionHeading';
import { getPackStyles } from './pack-styles';
import type { ProductCarouselProps } from '../types';

/**
 * Horizontal-scroll product strip. Card chrome + CTA pill style vary per pack:
 *   - Modern: rounded-2xl soft shadow + rounded-full pill CTA
 *   - Classic: sharp border + serif uppercase pill CTA
 *   - Minimal: no chrome + underlined "Add to cart" link CTA
 *   - Bold: 2px border + black uppercase block CTA
 *   - Elegant: hairline border + serif extralight outlined CTA
 *
 * Per Pecannbee deviation: we **show name + price** (Pecannbee hides them
 * with CSS for a B2B feel; B2C default keeps them visible).
 */
export function ProductCarousel({
  products,
  title,
  titleAr,
  seeAllHref,
  isRtl,
  currency = 'KWD',
  onAddToCart,
  urlPrefix = '',
  pack,
}: ProductCarouselProps) {
  if (products.length === 0) return null;
  const styles = getPackStyles(pack);

  return (
    <section className="px-4 sm:px-6 lg:px-8" dir={isRtl ? 'rtl' : 'ltr'}>
      <div className="mx-auto max-w-7xl">
        <SectionHeading
          title={title}
          titleAr={titleAr}
          isRtl={isRtl}
          seeAllHref={seeAllHref}
          pack={pack}
        />
        <ul
          className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 sm:gap-4"
          style={{ scrollbarWidth: 'thin' }}
        >
          {products.map(product => {
            const name = isRtl ? (product.nameAr ?? product.name) : product.name;
            const href = `${urlPrefix}/products/${product.slug}`;
            const img = product.images?.[0]?.url;
            const onSale = product.compareAtPrice && product.compareAtPrice > product.price;

            return (
              <li
                key={product.id}
                className="snap-start shrink-0 w-[42vw] sm:w-[28vw] lg:w-[16vw] max-w-[200px]"
              >
                <div className={`overflow-hidden transition-shadow hover:shadow-md ${styles.card}`}>
                  <Link
                    href={href}
                    className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    <div className="group/img relative aspect-square overflow-hidden bg-muted">
                      {img ? (
                        <>
                          <Image
                            src={img}
                            alt={name}
                            fill
                            sizes="(max-width: 640px) 42vw, (max-width: 1024px) 28vw, 200px"
                            className="object-cover transition-opacity duration-500 group-hover/img:opacity-0"
                          />
                          {product.images?.[1]?.url && (
                            <Image
                              src={product.images[1].url}
                              alt={name}
                              fill
                              sizes="(max-width: 640px) 42vw, (max-width: 1024px) 28vw, 200px"
                              loading="lazy"
                              className="absolute inset-0 object-cover opacity-0 transition-opacity duration-500 group-hover/img:opacity-100"
                            />
                          )}
                        </>
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                          <svg
                            className="h-10 w-10"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            aria-hidden
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={1.5}
                              d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                            />
                          </svg>
                        </div>
                      )}
                      {onSale && (
                        <span className="absolute end-2 top-2 rounded-full bg-destructive px-2 py-0.5 text-[10px] font-semibold text-destructive-foreground">
                          -
                          {Math.round(
                            (1 - product.price / (product.compareAtPrice ?? product.price)) * 100
                          )}
                          %
                        </span>
                      )}
                    </div>
                    <div className="px-3 py-2.5">
                      <p className={`line-clamp-2 min-h-[2.5em] ${styles.productCardName}`}>
                        {name}
                      </p>
                      <div className="mt-1 flex items-baseline gap-2">
                        <span className="font-semibold text-foreground">
                          {(product.price / 1000).toFixed(3)} {currency}
                        </span>
                        {onSale && product.compareAtPrice && (
                          <span className="text-xs text-muted-foreground line-through">
                            {(product.compareAtPrice / 1000).toFixed(3)}
                          </span>
                        )}
                      </div>
                    </div>
                  </Link>
                  {onAddToCart && (
                    <button
                      type="button"
                      onClick={() => onAddToCart(product.id)}
                      className={`block w-full text-center transition-colors cursor-pointer ${styles.productCardCta}`}
                    >
                      {isRtl ? 'إضافة للسلة' : 'Add to cart'}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
