'use client';

import { SectionHeading } from './SectionHeading';
import { getPackStyles } from './pack-styles';
import type { TestimonialItem, TestimonialRowProps } from '../types';

/** The quote shown by `layout: 'single'`: the first one short enough to set large, else the first. */
export function pickSingleTestimonial(list: TestimonialItem[]): TestimonialItem | undefined {
  return list.find(t => t.comment.trim().length > 0 && t.comment.length <= 220) ?? list[0];
}

/**
 * One customer line set large in the display face (Ruling B1-2, Vitrine). No stars, no card: the
 * words are the proof. The heading stays for screen readers so the section keeps a name.
 */
export function SingleTestimonial({
  testimonials,
  heading,
  isRtl,
}: {
  testimonials: TestimonialItem[];
  heading: string;
  isRtl?: boolean;
}) {
  const quote = pickSingleTestimonial(testimonials);
  if (!quote) return null;
  // Quote marks follow the quote's own script, not the page: an Arabic review on the English
  // page still reads «…», an English one on the Arabic page “…”.
  const arabicText = /[\u0600-\u06FF]/.test(quote.comment);
  return (
    <figure
      data-layout="single"
      dir={isRtl ? 'rtl' : 'ltr'}
      className="mx-auto max-w-3xl px-4 py-4 text-center sm:px-6"
    >
      <h2 className="sr-only">{heading}</h2>
      <blockquote
        dir="auto"
        className="font-display text-pretty text-2xl leading-relaxed text-foreground sm:text-3xl rtl:leading-[1.7]"
      >
        {arabicText ? '«' : '“'}
        {quote.comment.trim()}
        {arabicText ? '»' : '”'}
      </blockquote>
      <figcaption dir="auto" className="mt-5 text-sm text-muted-foreground">
        {quote.authorName}
        {quote.authorCity ? `${isRtl ? '، ' : ', '}${quote.authorCity}` : ''}
      </figcaption>
    </figure>
  );
}

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
  sectionBgColor,
  layout,
}: TestimonialRowProps) {
  if (testimonials.length === 0) return null;
  const styles = getPackStyles(pack);
  const heading = isRtl ? (titleAr ?? title ?? 'آراء العملاء') : (title ?? 'Customer Reviews');
  if (layout === 'single')
    return <SingleTestimonial testimonials={testimonials} heading={heading} isRtl={isRtl} />;

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
          sectionBgColor={sectionBgColor}
        />
        <div className="grid gap-7 sm:grid-cols-2 lg:grid-cols-3 lg:gap-9">
          {testimonials.slice(0, 6).map(t => (
            <article key={t.id} className={styles.testimonialCard}>
              <Stars rating={t.rating} isRtl={isRtl} />
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

function Stars({ rating, isRtl }: { rating: number; isRtl?: boolean }) {
  const full = Math.max(0, Math.min(5, Math.round(rating)));
  // R-05: named in the page's language; role=img so the name is announced at all.
  return (
    <div
      className="flex items-center gap-1"
      role="img"
      aria-label={isRtl ? `${full} من 5 نجوم` : `${full} of 5 stars`}
    >
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
