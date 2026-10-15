'use client';

import type { TestimonialRowProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { DAHAB_CONTAINER, DahabSectionHeading, pick } from './ui';
import { SingleTestimonial } from '../shared/TestimonialRow';

function Stars({ rating, label }: { rating: number; label: string }) {
  return (
    <span className="flex gap-1 text-primary" role="img" aria-label={label}>
      {[1, 2, 3, 4, 5].map(i => (
        <svg key={i} viewBox="0 0 12 12" className="h-3 w-3" aria-hidden="true">
          <path
            d="M6 .8 7.5 4.3l3.7.3-2.8 2.4.9 3.7L6 8.7 2.7 10.7l.9-3.7L.8 4.6l3.7-.3L6 .8Z"
            fill={i <= Math.round(rating) ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth=".7"
          />
        </svg>
      ))}
    </span>
  );
}

/** Customer words, set large in the display face; three across on desktop, a swipe row on phones. */
export function DahabTestimonialRow({
  testimonials,
  title,
  titleAr,
  isRtl: isRtlProp,
  layout,
}: TestimonialRowProps) {
  const { isRtl: ctxIsRtl, t } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  if (testimonials.length === 0) return null;
  // Platform variant (Ruling B1-2): Dahab honours the single-quote layout too.
  if (layout === 'single')
    return (
      <div className={DAHAB_CONTAINER}>
        <SingleTestimonial
          testimonials={testimonials}
          heading={pick(isRtl, title, titleAr) || t('Reviews', 'آراء العملاء')}
          isRtl={isRtl}
        />
      </div>
    );
  return (
    <div className={DAHAB_CONTAINER}>
      <DahabSectionHeading title={pick(isRtl, title, titleAr)} align="center" />
      <ul
        // Swipe row on phones: focusable so keyboard users can scroll it.
        tabIndex={0}
        aria-label={pick(isRtl, title, titleAr) || t('Reviews', 'آراء العملاء')}
        className="-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto rounded-sm px-4 pb-2 [scrollbar-width:none] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:-mx-6 sm:px-6 lg:mx-0 lg:grid lg:grid-cols-3 lg:gap-8 lg:overflow-visible lg:px-0 [&::-webkit-scrollbar]:hidden"
      >
        {testimonials.slice(0, 6).map(r => (
          <li
            key={r.id}
            className="flex w-[84%] shrink-0 snap-center flex-col border-t border-primary/40 pt-6 sm:w-[60%] lg:w-auto"
          >
            <Stars
              rating={r.rating}
              label={t(`${r.rating} out of 5 stars`, `${r.rating} من 5 نجوم`)}
            />
            <blockquote
              dir="auto"
              className="font-display mt-4 flex-1 text-pretty text-xl leading-snug text-foreground rtl:text-[1.35rem] rtl:leading-[1.7]"
            >
              {r.title ? <p className="mb-2 text-primary">{r.title}</p> : null}
              <p>{r.comment}</p>
            </blockquote>
            <p dir="auto" className="mt-6 text-sm text-muted-foreground">
              {r.authorName}
              {r.authorCity ? `، ${r.authorCity}`.replace('،', isRtl ? '،' : ',') : ''}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
