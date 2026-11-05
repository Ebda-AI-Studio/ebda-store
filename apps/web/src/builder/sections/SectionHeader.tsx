'use client';

/**
 * Heading row shared by the Phase 3 builder sections: title (and optional
 * subheading) at the inline start, an optional link at the inline end, a
 * hairline under both. Uses `font-display`, which is the pack's display face
 * where a pack defines one (Dahab) and the body face everywhere else.
 */
import Link from '../../components/StoreLink';
import { useStore } from '../../contexts/StoreContext';
import { getPackStyles } from '../../templates/shared/pack-styles';

export function SectionHeader({
  title,
  subtitle,
  linkLabel,
  linkHref,
  editTitle,
  editSubtitle,
  editLink,
  center = false,
}: {
  title?: string;
  subtitle?: string;
  linkLabel?: string;
  linkHref?: string;
  editTitle?: Record<string, string>;
  editSubtitle?: Record<string, string>;
  editLink?: Record<string, string>;
  center?: boolean;
}) {
  // LB-05 (W2a): on the qamar skin this row speaks the skin's one "view all" voice (the same
  // classes as SectionHeading's link, no chevron) over one hairline colour, so a Qamar page never
  // shows two link styles or two rule colours. Every other skin is unchanged.
  const { store } = useStore();
  // STOP-2 final review (P2-3): every pack skin that defines the heading + see-all voice (qamar,
  // souq) speaks it here, so a Souq page never shows two heading or two link styles either.
  const packSkin =
    store?.template === 'qamar' ||
    store?.template === 'souq' ||
    store?.template === 'jasmine' ||
    store?.template === 'lamma'
      ? store.template
      : null;
  const qamar = packSkin !== null;
  if (!title && !subtitle && !linkLabel) return null;
  return (
    <div className={center ? 'mb-8 text-center sm:mb-10' : 'mb-8 sm:mb-10'}>
      {/* IA-16: the title and See all share one row on the text baseline; the subtitle follows. */}
      <div
        data-heading-row
        className={`flex flex-wrap items-baseline gap-x-6 gap-y-2 ${center ? 'justify-center' : 'justify-between'}`}
      >
        {title && (
          <h2
            className={
              qamar
                ? `min-w-0 ${getPackStyles(packSkin ?? 'qamar').sectionHeading}`
                : 'min-w-0 font-display text-balance text-[clamp(1.5rem,1.1rem+1.4vw,2.35rem)] leading-tight text-foreground rtl:leading-[1.45]'
            }
            data-part="section-title"
            {...editTitle}
          >
            {title}
          </h2>
        )}
        {linkLabel && linkHref && !center && (
          <Link
            href={linkHref}
            className={
              qamar
                ? `inline-flex min-h-[44px] min-w-11 items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${getPackStyles(packSkin ?? 'qamar').sectionSeeAll}`
                : 'inline-flex min-h-[44px] items-center gap-1 text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm'
            }
            {...editLink}
          >
            {linkLabel}
            {!qamar && (
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className="h-3.5 w-3.5 rtl:-scale-x-100"
                aria-hidden="true"
              >
                <path d="m9 6 6 6-6 6" />
              </svg>
            )}
          </Link>
        )}
      </div>
      {subtitle && (
        <p
          className={`mt-2 max-w-[56ch] text-pretty text-[15px] leading-relaxed text-muted-foreground ${center ? 'mx-auto' : ''}`}
          {...editSubtitle}
        >
          {subtitle}
        </p>
      )}
      <div
        aria-hidden="true"
        className={
          qamar
            ? center
              ? 'mx-auto mt-5 h-px max-w-[180px] bg-border'
              : 'mt-5 h-px bg-border'
            : center
              ? 'mx-auto mt-5 h-px max-w-[180px] bg-gradient-to-r from-transparent via-primary/60 to-transparent'
              : 'mt-5 h-px bg-gradient-to-r from-primary/50 via-border to-transparent rtl:bg-gradient-to-l'
        }
      />
    </div>
  );
}
