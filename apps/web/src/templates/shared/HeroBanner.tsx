'use client';

import type React from 'react';
import Image from 'next/image';
import Link from '../../components/StoreLink';
import { cn } from '@ebda/ui';
import { IMAGE_STANDARDS, heroObjectPosition, sanitizeUrl } from '@ebda/shared';
import type { HeroBannerProps } from '../types';
import { HERO_TEXT_SCRIM, getPackStyles } from './pack-styles';
import { heroHeadlineFontSize } from './section-typography';
import { HeroBannerLink } from './HeroBannerLink';
import { translations } from '../../contexts/LanguageContext';
import { HeroVideo } from '../../components/commerce/HeroVideo';

/**
 * Single hero banner — full-bleed image, optional headline overlay + CTA.
 * Per-pack typography & CTA style via `pack` so each template's voice is
 * preserved (Bold uppercase / Classic serif / Elegant extralight / etc.).
 *
 * Mobile aspect ratio is derived from IMAGE_STANDARDS.heroMobile (single
 * source of truth in packages/shared) so the render and the admin upload
 * hint can never drift from each other.
 */

// Single source of truth: mobile aspect derived from the shared standard.
// Change heroMobile in image-standards.ts and both the admin hint and the
// storefront render update automatically.
const HERO_MOBILE = IMAGE_STANDARDS.heroMobile;

export function HeroBanner({
  image,
  imageAr,
  imageMobile,
  imageMobileAr,
  video,
  videoMobile,
  focus,
  active = true,
  alt = '',
  headline,
  headlineAr,
  subtitle,
  subtitleAr,
  ctaText,
  ctaTextAr,
  ctaHref,
  link,
  isRtl,
  pack,
  priority = true,
  presentation = 'full-bleed',
  frameLine = false,
  textAnchor,
  inSlider = false,
  copyOnly = false,
  headingZone,
  urlPrefix,
  builderBlockId,
}: HeroBannerProps) {
  const isFramed = presentation === 'framed';
  const drawFrame = isFramed && frameLine;
  const desktopSrc = (isRtl && imageAr) || image;
  // Mobile-specific source falls back to the desktop image when not set.
  const dedicatedMobileSrc = (isRtl && imageMobileAr) || imageMobile;
  const mobileSrc = dedicatedMobileSrc || desktopSrc;

  // Mobile hero aspect: derived from IMAGE_STANDARDS.heroMobile via a CSS
  // CUSTOM PROPERTY consumed by the `aspect-[var(--hero-m-aspect)]` class, so
  // the shared standard still drives it WITHOUT drifting AND the desktop
  // `sm:aspect-[1920/700]` class can override it on ≥640px.
  //
  // 2026-06-04: this was previously an inline `style={{ aspectRatio }}`, which
  // ALWAYS beats a Tailwind class regardless of media query — inline styles
  // win the cascade. So `sm:aspect-[1920/700]` never applied and the DESKTOP
  // banner was stuck at whatever mobile aspect was last set (the live A/B
  // mobile-aspect tests #49–#52 leaked onto desktop — "mobile banner showing
  // on desktop", Ahmad). A custom property is just a value, not an
  // aspect-ratio declaration, so the responsive class override works normally.
  // max-h-[45vh] caps the banner on larger phones/tablets so categories below
  // remain visible. Upload hint: heroMobile for dedicated mobile images;
  // 1920×700 desktop images center-crop cleanly via object-cover.
  const mobileAspectStyle = {
    '--hero-m-aspect': `${HERO_MOBILE.width} / ${HERO_MOBILE.height}`,
  } as React.CSSProperties;

  const text = isRtl ? (headlineAr ?? headline) : (headline ?? headlineAr);
  const subtitleText = isRtl ? (subtitleAr ?? subtitle) : (subtitle ?? subtitleAr);
  const cta = isRtl ? (ctaTextAr ?? ctaText) : (ctaText ?? ctaTextAr);
  const showOverlay = !!(text || subtitleText || cta);
  const styles = getPackStyles(pack);
  // W2a (L-04): copy anchored at the bottom-start corner. A single banner moves the copy under
  // the photo below `xl` (a 4:3 phone hero or a 1920/700 tablet hero is too short to hold a
  // headline and a button over less than 40% of the photo); a slide keeps fixed geometry, so its
  // copy stays on the photo at every width.
  const anchored = textAnchor === 'bottom-start' && showOverlay;
  // W2a fix round 1 (I-1): a slider keeps its slides' geometry, so below xl its copy is rendered
  // under the track by HeroSlider (`copyOnly`), and the copy on the photo shows from xl only.
  const stacked = anchored && (!inSlider || copyOnly);

  // Store-slug prefix (relative internal links only — see urlPrefix doc on
  // HeroBannerProps) so the CTA keeps store context on a platform host.
  const safeCtaHref = sanitizeUrl(ctaHref);
  const resolvedCtaHref =
    urlPrefix && safeCtaHref.startsWith('/') ? `${urlPrefix}${safeCtaHref}` : safeCtaHref;

  // Resolve hero headline color at runtime so it is never hardcoded to white.
  // Priority order:
  //   1. Merchant typography-zone override (headingZone?.color) — explicit pick wins.
  //   2. pickReadableForeground against white — the hero background is always an
  //      image so there is no solid-color bg to analyse. We default the analysis
  //      bg to '#ffffff' which returns '#000000', but that would be wrong on a
  //      dark photo. For image heroes the safe default is '#ffffff' (white on imagery
  //      is the industry convention; the gradient overlay in heroOverlay adds further
  //      scrim). We therefore skip the luminance check for image heroes and just
  //      use '#ffffff' as the fallback, matching the original text-white intent.
  //
  // NOTE: if a future caller ever passes a solid bgColor prop we can switch to
  //       pickReadableForeground(resolveColor(bgColor, theme) ?? '#000000') here.
  const heroColor: string = headingZone?.color ?? '#ffffff';

  // Accessible label for the stretched banner-link anchor (HeroBannerLink):
  // prefer the visible headline, then the image alt text, then a generic
  // localized fallback so screen-reader users always get context for the
  // "whole slide is clickable" affordance.
  const bannerLabel = text || alt || (isRtl ? translations['View more'] : 'View more');

  // Framed mode (Ahmad 2026-05-17 night): merchant uploaded an image
  // they want shown in FULL without crop. Sit the hero inside a
  // max-w-7xl container with horizontal padding + rounded-2xl frame +
  // neutral bg, render image with object-contain so the whole asset
  // displays (may letterbox at the sides on portrait-ish sources).
  // Full-bleed mode (default, pre-existing behavior): edge-to-edge,
  // object-cover. Both modes share the same aspect ratio wrappers.
  // A drawn frame (look stores, B1-41) takes the look's corner radius so frame and hairline agree.
  const containerBaseClass = isFramed
    ? `relative w-full overflow-hidden ${drawFrame ? 'rounded-[var(--radius)]' : 'rounded-2xl'} bg-muted aspect-[var(--hero-m-aspect)] max-h-[45vh] sm:aspect-[1920/700] sm:max-h-none`
    : 'relative w-full overflow-hidden bg-muted aspect-[var(--hero-m-aspect)] max-h-[45vh] sm:aspect-[1920/700] sm:max-h-none';
  // A drawn frame (Vitrine, B1-41) is a shop window: the photo fills the frame (cover + focus)
  // instead of letterboxing on the muted ground, and the hairline is the frame.
  const contain = isFramed && !drawFrame;
  const imageObjectClass = contain ? 'object-contain' : 'object-cover';
  // Focus only matters when the image is cropped (cover), B1-32.
  const objectPosition = contain ? undefined : heroObjectPosition(focus);

  const posterPicture = desktopSrc ? (
    <picture>
      <source media="(max-width: 639px)" srcSet={mobileSrc} />
      <Image
        src={desktopSrc}
        alt={alt}
        fill
        priority={priority}
        loading={priority ? undefined : 'lazy'}
        sizes="100vw"
        // object-cover (full-bleed): backend auto-resize lands every new
        // upload at the exact container aspect (16:9 mobile / 1920×700
        // desktop) via sharp before R2, so cover trims zero pixels for
        // post-auto-resize uploads. Pre-feature legacy assets may crop
        // slightly.
        // object-contain (framed): whole image displays inside the
        // container, letterbox bars fill with the neutral bg above.
        // Pick by `presentation` prop / merchant admin toggle.
        className={imageObjectClass}
        style={objectPosition ? { objectPosition } : undefined}
      />
    </picture>
  ) : null;

  // The anchored copy block (W2a, L-04). On the photo it sits on HERO_TEXT_SCRIM: a band that is
  // solid behind the text and fades out over `fade` above it, so the scrim covers the text block
  // only and the rest of the photo stays clear. Under the photo (`stacked`, below xl) it is page
  // text: the theme's ink, the primary button. The merchant's headline colour (typography zone)
  // applies on the photo only; on the page the headline keeps the page ink.
  const scrimRgb = `rgb(${HERO_TEXT_SCRIM.rgb} / ${HERO_TEXT_SCRIM.alpha})`;
  // The band also fades out toward the inline end (mask), so it shades the text's corner and not
  // a full-width strip of the photo: solid under the copy column, clear past HERO_TEXT_SCRIM.reach.
  const scrimMask = `linear-gradient(to ${isRtl ? 'left' : 'right'}, #000 0%, #000 ${HERO_TEXT_SCRIM.solidTo}, transparent ${HERO_TEXT_SCRIM.reach})`;
  const scrimStyle = {
    backgroundImage: `linear-gradient(to top, ${scrimRgb} 0%, ${scrimRgb} calc(100% - ${HERO_TEXT_SCRIM.fade}), rgb(${HERO_TEXT_SCRIM.rgb} / 0) 100%)`,
    maskImage: scrimMask,
    WebkitMaskImage: scrimMask,
    '--hero-ink': heroColor,
  } as React.CSSProperties;
  const anchoredCopy = anchored ? (
    <div
      data-part="hero-copy"
      data-anchor={stacked ? 'stacked' : 'corner'}
      className={cn(
        stacked
          ? cn(
              'relative pb-6 pt-5 xl:absolute xl:inset-x-0 xl:bottom-0 xl:z-10 xl:overflow-hidden xl:px-10 xl:pb-7 xl:pt-8',
              // Framed: the page container already pads the copy; the scrim follows the frame.
              isFramed
                ? `px-1 sm:px-0 ${drawFrame ? 'xl:rounded-b-[var(--radius)]' : 'xl:rounded-b-2xl'}`
                : 'px-4 sm:px-6 lg:px-8'
            )
          : 'absolute inset-x-0 bottom-0 z-10 hidden px-10 pb-7 pt-8 xl:block',
        'text-start'
      )}
      // The scrim paints only where the copy is on the photo.
      style={stacked ? ({ '--hero-ink': heroColor } as React.CSSProperties) : scrimStyle}
    >
      {stacked && (
        <span
          aria-hidden="true"
          data-part="hero-scrim"
          className="pointer-events-none absolute inset-0 hidden xl:block"
          style={scrimStyle}
        />
      )}
      <div className="relative max-w-xl">
        {text && (
          <h1
            className={cn(
              styles.heroHeadline,
              'text-balance',
              stacked
                ? 'text-foreground xl:text-[color:var(--hero-ink)]'
                : 'text-[color:var(--hero-ink)]',
              'drop-shadow-none'
            )}
            data-zone="heroHeadline"
            data-builder-setting={builderBlockId ? (isRtl ? 'headlineAr' : 'headline') : undefined}
            style={{
              fontFamily: headingZone?.fontFamily,
              fontSize: heroHeadlineFontSize(headingZone?.fontSize),
              fontWeight: headingZone?.fontWeight,
              letterSpacing: headingZone?.letterSpacing,
              lineHeight: headingZone?.lineHeight,
              textTransform: headingZone?.textTransform as React.CSSProperties['textTransform'],
            }}
          >
            {text}
          </h1>
        )}
        {subtitleText && (
          <p
            className={cn(
              'mt-2 text-base',
              stacked ? 'text-muted-foreground xl:text-white/90' : 'text-white/90'
            )}
          >
            {subtitleText}
          </p>
        )}
        {cta && ctaHref && (
          <Link
            href={resolvedCtaHref}
            className={cn(
              'relative z-10 mt-4 inline-flex min-h-[44px] items-center justify-center rounded-[var(--radius)] px-7 py-3 text-sm font-medium transition-colors',
              stacked
                ? 'bg-primary text-primary-foreground hover:bg-primary/90 xl:bg-white xl:text-[#141414] xl:hover:bg-white/90'
                : 'bg-white text-[#141414] hover:bg-white/90'
            )}
            data-cta="button"
            data-builder-setting={builderBlockId ? (isRtl ? 'ctaTextAr' : 'ctaText') : undefined}
          >
            {cta}
          </Link>
        )}
      </div>
    </div>
  ) : null;

  const heroSection = (
    // Mobile: aspect-[var(--hero-m-aspect)] (value supplied via style) + 45vh ceiling.
    // Desktop (sm:): sm:aspect-[1920/700] overrides the base class via media query —
    // both are classes now, so the later sm: utility wins (no inline-style override
    // trap). sm:max-h-none removes the mobile ceiling. overflow-hidden clips both.
    <section
      className={containerBaseClass}
      style={mobileAspectStyle}
      dir={isRtl ? 'rtl' : 'ltr'}
      data-frame-draw={drawFrame ? '' : undefined}
      data-builder-block={!inSlider ? builderBlockId : undefined}
      data-builder-image={builderBlockId ? (isRtl && imageAr ? 'imageAr' : 'image') : undefined}
    >
      <HeroBannerLink link={link} label={bannerLabel} urlPrefix={urlPrefix}>
        {desktopSrc &&
          (video ? (
            // The poster picture stays the base layer (and the LCP element);
            // HeroVideo only overlays a muted looping video after hydration.
            <HeroVideo
              src={video}
              srcMobile={videoMobile}
              mobileQuery="(max-width: 639px)"
              active={active}
              fit={contain ? 'contain' : 'cover'}
              position={objectPosition}
            >
              {posterPicture}
            </HeroVideo>
          ) : (
            posterPicture
          ))}

        {showOverlay && !anchored && (
          <div
            className={`absolute inset-0 flex items-center justify-center ${styles.heroOverlay}`}
          >
            <div className="mx-auto max-w-3xl px-6 text-center">
              {text && (
                <h1
                  className={styles.heroHeadline}
                  data-zone="heroHeadline"
                  data-builder-setting={
                    builderBlockId ? (isRtl ? 'headlineAr' : 'headline') : undefined
                  }
                  style={{
                    fontFamily: headingZone?.fontFamily,
                    fontSize: heroHeadlineFontSize(headingZone?.fontSize),
                    fontWeight: headingZone?.fontWeight,
                    // heroColor is always defined: merchant pick OR '#ffffff' fallback.
                    // This replaces the removed `text-white` in heroHeadline pack-styles
                    // so every theme still gets a legible color without a hardcoded class.
                    color: heroColor,
                    letterSpacing: headingZone?.letterSpacing,
                    lineHeight: headingZone?.lineHeight,
                    textTransform:
                      headingZone?.textTransform as React.CSSProperties['textTransform'],
                  }}
                >
                  {text}
                </h1>
              )}
              {subtitleText && (
                <p className="mt-3 text-base sm:text-lg text-white/90 drop-shadow">
                  {subtitleText}
                </p>
              )}
              {cta && ctaHref && (
                // relative z-10: sits above HeroBannerLink's `absolute inset-0
                // z-0` stretched anchor (when `link` is set) so the CTA's own
                // destination wins the click, per the stretched-link pattern.
                <Link
                  href={resolvedCtaHref}
                  className={cn(
                    'relative z-10 mt-6 inline-flex items-center justify-center',
                    styles.heroCta
                  )}
                  data-cta="button"
                  data-builder-setting={
                    builderBlockId ? (isRtl ? 'ctaTextAr' : 'ctaText') : undefined
                  }
                >
                  {cta}
                </Link>
              )}
            </div>
          </div>
        )}
        {anchored && !stacked && anchoredCopy}
      </HeroBannerLink>
      {drawFrame && (
        // Vitrine's hairline (Rulings B1-5, B1-7): the line colour inset from the frame edge,
        // drawn in once from the centre (globals.css `frame-draw`). Decorative, never clickable.
        <span
          aria-hidden="true"
          data-part="frame-line"
          className="pointer-events-none absolute inset-3 rounded-[var(--radius)] border border-border sm:inset-4"
        />
      )}
    </section>
  );

  // HeroSlider's below-the-track copy for the active slide (phones and tablets only).
  if (copyOnly) return anchored ? <div className="xl:hidden">{anchoredCopy}</div> : null;

  // A stacked copy block follows the photo in flow (below xl) and is laid over its bottom from xl,
  // so the photo keeps its exact aspect and crop at every width.
  const withCopy = stacked ? (
    <div className="relative" data-hero-anchor="bottom-start">
      {heroSection}
      {anchoredCopy}
    </div>
  ) : (
    heroSection
  );

  return isFramed ? (
    <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 sm:py-6">{withCopy}</div>
  ) : (
    withCopy
  );
}
