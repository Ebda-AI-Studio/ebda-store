'use client';

import { SectionHeading } from './SectionHeading';
import { getPackStyles } from './pack-styles';
import type { TestimonialRowProps } from '../types';

/**
 * 3-up testimonial row. Card chrome + author typography vary per pack:
 *   - Modern: rounded-2xl card + medium author
 *   - Classic: sharp border + serif uppercase author
 *   - Minimal: no chrome, top border only + light author
 *   - Bold: 2px border + black uppercase author
 *   - Elegant: hairline top border + serif/extralight tracked author
 */
export function TestimonialRow({
  testimonials,
  title,
  titleAr,
  isRtl,
  pack,
  headingZone,
  kickerZone,
  subtitleZone,
  dividers,
}: TestimonialRowProps) {
  if (testimonials.length === 0) return null;
  const styles = getPackStyles(pack);
  const heading = isRtl ? (titleAr ?? title ?? 'آراء العملاء') : (title ?? 'Customer Reviews');

  return (
    <section className="px-4 sm:px-6 lg:px-8" dir={isRtl ? 'rtl' : 'ltr'}>
      <div className="mx-auto max-w-7xl">
        <SectionHeading
          title={heading}
          isRtl={isRtl}
          pack={pack}
          headingZone={headingZone}
          kickerZone={kickerZone}
          subtitleZone={subtitleZone}
          dividers={dividers}
        />
        <div className="grid gap-7 sm:grid-cols-2 lg:grid-cols-3 lg:gap-9">
          {testimonials.slice(0, 6).map(t => (
            <article key={t.id} className={styles.testimonialCard}>
              <Stars rating={t.rating} />
              {t.title && (
                <h3 className="mt-5 text-lg font-semibold text-foreground line-clamp-1 tracking-tight">
                  {t.title}
                </h3>
              )}
              <p className="mt-3 text-base text-foreground/85 leading-relaxed line-clamp-5">
                {t.comment}
              </p>
              <footer className="mt-7 border-t border-foreground/10 pt-5">
                <p className={styles.testimonialAuthor}>{t.authorName}</p>
                {t.authorCity && (
                  <p className="text-sm text-muted-foreground mt-1.5">{t.authorCity}</p>
                )}
              </footer>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function Stars({ rating }: { rating: number }) {
  const full = Math.max(0, Math.min(5, Math.round(rating)));
  return (
    <div className="flex items-center gap-1" aria-label={`${full} of 5 stars`}>
      {Array.from({ length: 5 }).map((_, i) => (
        <svg
          key={i}
          className={`h-5 w-5 ${i < full ? 'text-warning' : 'text-muted'}`}
          fill="currentColor"
          viewBox="0 0 20 20"
          aria-hidden
        >
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.286 3.962a1 1 0 00.95.69h4.166c.969 0 1.371 1.24.588 1.81l-3.37 2.448a1 1 0 00-.364 1.118l1.286 3.962c.3.922-.755 1.688-1.539 1.118l-3.37-2.448a1 1 0 00-1.176 0l-3.37 2.448c-.784.57-1.838-.196-1.539-1.118l1.286-3.962a1 1 0 00-.364-1.118L2.05 9.389c-.783-.57-.38-1.81.588-1.81h4.166a1 1 0 00.95-.69l1.286-3.962z" />
        </svg>
      ))}
    </div>
  );
}
