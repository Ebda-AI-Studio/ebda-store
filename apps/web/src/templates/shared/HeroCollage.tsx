'use client';

import Image from 'next/image';
import Link from '../../components/StoreLink';
import { sanitizeUrl, type HeroSlide } from '@ebda/shared';
import { HeroBannerLink } from './HeroBannerLink';
import { translations } from '../../contexts/LanguageContext';
import { zoneStyle, heroHeadlineFontSize, type ResolvedZone } from './section-typography';

/**
 * The surface the collage headline + CTA sit on: the page colour, fully opaque (C28). The text
 * never sits over a photo, so on a dark look (Lookbook: ink #F4F1FA on page #1E2340) it is a
 * dark solid panel under light text. Pinned by import in tests/unit/qamar-looks-contrast.test.ts.
 */
export const HERO_COLLAGE_TEXT_PANEL = { token: 'background', opacity: 1 } as const;

const pick = (isRtl: boolean, en?: string, ar?: string) => (isRtl ? ar || en : en || ar) || '';

/**
 * Collage hero (hero `presentation: 'collage'`, Ruling B1-2; the Qamar Lookbook look): the first
 * three slide photos overlap, with one headline and one CTA from the first slide beside them
 * (below on a phone) on the opaque page colour. A platform variant: every skin renders it from
 * the `PageRenderer` hero wrapper, which owns `data-section="hero"`.
 *
 * The first photo is the LCP element (eager, high priority) and only slides into place; the
 * other two also fade in (`[data-collage-settle]` in globals.css, Ruling B1-7), all off under
 * reduced motion. Fewer than 3 photos → null, and the renderer falls back to the banner.
 */
export function HeroCollage({
  slides,
  isRtl,
  urlPrefix,
  headingZone,
}: {
  slides: HeroSlide[];
  isRtl: boolean;
  urlPrefix: string;
  headingZone?: ResolvedZone;
}) {
  const photos = slides
    .map(s => ({ slide: s, src: (isRtl && s.imageAr) || s.image }))
    .filter((p): p is { slide: HeroSlide; src: string } => !!p.src)
    .slice(0, 3);
  if (photos.length < 3) return null;
  const lead = photos[0].slide;
  const headline = pick(isRtl, lead.headline, lead.headlineAr);
  const cta = pick(isRtl, lead.ctaText, lead.ctaTextAr);
  const safeCta = sanitizeUrl(lead.ctaHref, '/products');
  const ctaHref = urlPrefix && safeCta.startsWith('/') ? `${urlPrefix}${safeCta}` : safeCta;
  const label = headline || lead.alt || (isRtl ? translations['View more'] : 'View more');

  // Logical grid columns: in Arabic the lead photo starts on the right. LB-a: a gapped grid,
  // no overlap and no stroke (a background ring cut into the lead photo, and the near-equal
  // tops, 5px apart, read as accidental). The lead and the first side tile share a top edge;
  // the second side tile closes the bottom; both side tiles are square (P2-10: 148 vs 111px read as
  // accidental). Each photo is a positioned frame for next/image.
  const frames = [
    'col-span-4 col-start-1 aspect-[4/5]',
    'col-span-2 col-start-5 self-start aspect-square',
    'col-span-2 col-start-5 self-end aspect-square',
  ];
  const sizes = [
    '(min-width: 768px) 38vw, 66vw',
    '(min-width: 768px) 29vw, 50vw',
    '(min-width: 768px) 19vw, 33vw',
  ];

  return (
    <div data-presentation="collage" className="relative overflow-hidden bg-background">
      <HeroBannerLink link={lead.link} label={label} urlPrefix={urlPrefix}>
        <div className="mx-auto grid max-w-7xl gap-y-8 px-4 pb-10 pt-6 sm:px-6 md:grid-cols-12 md:items-center md:gap-x-10 md:pb-14 md:pt-10 lg:px-8">
          <div className="grid grid-cols-6 gap-3 md:col-span-7" data-collage-settle>
            {photos.map((p, i) => (
              <div
                key={i}
                className={`pointer-events-none relative row-start-1 overflow-hidden rounded-[var(--radius)] bg-muted ${frames[i]}`}
              >
                <Image
                  src={p.src}
                  alt={p.slide.alt ?? ''}
                  fill
                  sizes={sizes[i]}
                  loading={i === 0 ? 'eager' : 'lazy'}
                  fetchPriority={i === 0 ? 'high' : undefined}
                  className="object-cover"
                />
              </div>
            ))}
          </div>
          {(headline || cta) && (
            <div
              data-part="collage-text"
              className="relative bg-background text-start md:col-span-5"
            >
              {headline && (
                <h1
                  data-zone="heroHeadline"
                  className="font-display text-balance leading-[1.3] text-foreground"
                  style={{
                    ...zoneStyle(headingZone),
                    fontSize: heroHeadlineFontSize(headingZone?.fontSize),
                  }}
                >
                  {headline}
                </h1>
              )}
              {cta && (
                // relative z-10: above HeroBannerLink's stretched anchor, so the CTA keeps its own
                // destination. Press feedback only (<= 160ms, quality bar §7).
                <Link
                  href={ctaHref}
                  className="relative z-10 mt-6 inline-flex min-h-[48px] items-center justify-center rounded-[var(--radius)] bg-primary px-7 text-sm font-medium text-primary-foreground transition-transform duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[0.98]"
                >
                  {cta}
                </Link>
              )}
            </div>
          )}
        </div>
      </HeroBannerLink>
    </div>
  );
}
