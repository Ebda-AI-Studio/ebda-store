'use client';

/**
 * Dahab hero (Phase B5, Ruling B5-1): the headline set in the look's display face at the inline
 * start (the right edge in Arabic) with one action. From `lg` the photograph is full-bleed and the
 * copy sits over a page-coloured fade; on phones and tablets the photograph takes the top of the
 * frame and the copy sits BELOW it on the page colour, so text never covers the piece (taste profile).
 * No entrance motion: the rule that drew in and the copy that rose were the old skin's signature
 * and are retired with it. Every colour is a look token.
 *
 * Art direction: a separate mobile crop through <picture> (Cloudflare serves
 * storefront images unoptimized, so the crop IS the delivered file). The
 * first slide is the LCP element: eager, high priority.
 */
import { useEffect, useRef, useState } from 'react';
import Link from '../../components/StoreLink';
import { heroObjectPosition } from '@ebda/shared';
import type { HeroBannerProps, HeroProps, HeroSliderProps } from '../types';
import { resolveBannerLink } from '../shared/hero-banner-link-utils';
import { HeroVideo } from '../../components/commerce/HeroVideo';
import { useLanguage } from '../../contexts/LanguageContext';
import { DAHAB_BTN_PRIMARY, DAHAB_CONTAINER, cx, pick } from './ui';
import { imageSrcSet } from '../../lib/image-loader';

function Slide({
  slide,
  isRtl,
  urlPrefix,
  priority,
  active = true,
}: {
  slide: HeroBannerProps;
  isRtl: boolean;
  urlPrefix: string;
  priority: boolean;
  active?: boolean;
}) {
  const image = (isRtl && slide.imageAr) || slide.image;
  const imageMobile =
    (isRtl && slide.imageMobileAr) || slide.imageMobile || (isRtl && slide.imageAr) || slide.image;
  const headline = pick(isRtl, slide.headline, slide.headlineAr);
  const subtitle = pick(isRtl, slide.subtitle, slide.subtitleAr);
  const cta = pick(isRtl, slide.ctaText, slide.ctaTextAr);
  const ctaHref = resolveBannerLink(slide.ctaHref || slide.link, urlPrefix);
  const wholeLink = !cta ? resolveBannerLink(slide.link, urlPrefix) : null;

  const posterPicture = (
    <picture>
      {imageMobile && imageMobile !== image && (
        <source
          media="(max-width: 1023px)"
          srcSet={imageSrcSet(imageMobile, 1280) ?? imageMobile}
          sizes="100vw"
        />
      )}
      <img
        src={image}
        srcSet={imageSrcSet(image, 1920)}
        sizes="100vw"
        alt={slide.alt || headline || ''}
        loading={priority ? 'eager' : 'lazy'}
        fetchPriority={priority ? 'high' : 'auto'}
        decoding={priority ? 'sync' : 'async'}
        className="absolute inset-0 h-full w-full object-cover"
        style={
          heroObjectPosition(slide.focus)
            ? { objectPosition: heroObjectPosition(slide.focus) }
            : undefined
        }
      />
    </picture>
  );

  const body = (
    <>
      {/* The photograph: a block of its own height below lg, the whole frame from lg. */}
      <div className="relative h-[min(52svh,440px)] overflow-hidden md:h-[min(46vh,480px)] lg:absolute lg:inset-0 lg:h-auto">
        {slide.video ? (
          // The poster picture is the base layer and the LCP element; the video
          // only overlays it after hydration (muted, looping, reduced-motion safe).
          <HeroVideo
            src={slide.video}
            srcMobile={slide.videoMobile}
            mobileQuery="(max-width: 1023px)"
            active={active}
            position={heroObjectPosition(slide.focus)}
          >
            {posterPicture}
          </HeroVideo>
        ) : (
          posterPicture
        )}
      </div>
      {/* From lg the page colour fades in from the inline start so the copy sits on a calm ground. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 hidden lg:block lg:bg-gradient-to-r lg:from-background/90 lg:via-background/45 lg:to-transparent lg:rtl:bg-gradient-to-l"
      />
      {(headline || subtitle || cta) && (
        <div
          className={cx(
            DAHAB_CONTAINER,
            // PREMIUM-31: below lg the copy is in the flow under the photo, so the frame is exactly as tall as
            // its content (a fixed 44% left ~140 px of dead white under the button); `pb-12` keeps the slide dots clear
            'relative flex min-h-[11rem] items-start pb-12 pt-5 lg:absolute lg:inset-0 lg:h-full lg:min-h-0 lg:items-center lg:pb-0 lg:pt-0'
          )}
        >
          <div className="max-w-[34rem]">
            {headline && (
              <h1 className="font-display text-balance text-[clamp(2.25rem,1.2rem+4.4vw,4.5rem)] leading-[1.1] text-foreground rtl:leading-[1.4]">
                {headline}
              </h1>
            )}
            {subtitle && (
              <p className="mt-3 max-w-[42ch] text-pretty text-base leading-relaxed text-foreground/80 md:mt-5 md:text-[17px]">
                {subtitle}
              </p>
            )}
            {cta && ctaHref && (
              <Link href={ctaHref} className={cx(DAHAB_BTN_PRIMARY, 'mt-5 md:mt-8')}>
                {cta}
              </Link>
            )}
          </div>
        </div>
      )}
    </>
  );

  return wholeLink ? (
    <Link
      href={wholeLink}
      className="relative block lg:absolute lg:inset-0"
      aria-label={headline || slide.alt || ''}
    >
      {body}
    </Link>
  ) : (
    <div className="relative lg:absolute lg:inset-0">{body}</div>
  );
}

// Below lg the frame takes its height from its content (photo block + copy); from lg it is a fixed full-bleed stage.
const FRAME =
  'relative isolate w-full overflow-hidden bg-background lg:h-[min(84vh,760px)] lg:min-h-[520px]';

export function DahabHeroBanner(props: HeroBannerProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const isRtl = props.isRtl ?? ctxIsRtl;
  return (
    <section
      className={FRAME}
      aria-label={pick(isRtl, props.headline, props.headlineAr) || undefined}
    >
      <Slide slide={props} isRtl={isRtl} urlPrefix={props.urlPrefix ?? ''} priority />
    </section>
  );
}

export function DahabHeroSlider({
  slides,
  autoplayMs = 6000,
  isRtl: isRtlProp,
  urlPrefix = '',
}: HeroSliderProps) {
  const { isRtl: ctxIsRtl, t } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  // Slides after the first mount once the page has finished loading, so the
  // first photograph (the LCP element) never shares bandwidth with them.
  const [rest, setRest] = useState(false);
  useEffect(() => {
    const go = () => window.setTimeout(() => setRest(true), 1500);
    if (document.readyState === 'complete') {
      const id = go();
      return () => window.clearTimeout(id);
    }
    window.addEventListener('load', go, { once: true });
    return () => window.removeEventListener('load', go);
  }, []);
  const reduced = useRef(false);
  const count = slides.length;

  useEffect(() => {
    reduced.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);
  useEffect(() => {
    if (count < 2 || paused || reduced.current || !rest) return;
    const id = window.setTimeout(() => setIndex(i => (i + 1) % count), Math.max(3000, autoplayMs));
    return () => window.clearTimeout(id);
  }, [index, paused, count, autoplayMs, rest]);

  if (count === 0) return null;
  if (count === 1) return <DahabHeroBanner {...slides[0]} isRtl={isRtl} urlPrefix={urlPrefix} />;

  return (
    <section
      className={cx(FRAME, 'grid lg:block')}
      aria-roledescription="carousel"
      aria-label={t('Featured', 'مختارات')}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      {slides.map((s, i) => (
        <div
          key={i}
          role="group"
          aria-roledescription="slide"
          aria-label={`${i + 1} / ${count}`}
          aria-hidden={i !== index}
          inert={i !== index ? true : undefined}
          className={cx(
            // one grid cell below lg (the frame is as tall as the tallest slide), stacked absolutely from lg
            'col-start-1 row-start-1 transition-opacity duration-[1200ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none lg:absolute lg:inset-0',
            i === index ? 'opacity-100' : 'opacity-0'
          )}
        >
          {(i === 0 || rest) && (
            <Slide
              slide={s}
              isRtl={isRtl}
              urlPrefix={urlPrefix}
              priority={i === 0}
              active={i === index}
            />
          )}
        </div>
      ))}
      <div
        className={cx(
          DAHAB_CONTAINER,
          'pointer-events-none absolute inset-x-0 bottom-5 flex gap-2'
        )}
      >
        {slides.map((_, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setIndex(i)}
            aria-label={t(`Show slide ${i + 1}`, `عرض الشريحة ${i + 1}`)}
            aria-current={i === index}
            className="pointer-events-auto flex h-11 w-11 items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span
              className={cx(
                'block h-px w-full transition-colors duration-500',
                i === index ? 'bg-primary' : 'bg-foreground/35'
              )}
            />
          </button>
        ))}
      </div>
    </section>
  );
}

/** Legacy hero fields (title/subtitle/image) — same frame, one slide. */
export default function DahabHero({
  title,
  titleAr,
  subtitle,
  subtitleAr,
  image,
  ctaText,
  ctaTextAr,
  ctaLink,
  isRtl,
  urlPrefix,
}: HeroProps) {
  if (!image) return null;
  return (
    <DahabHeroBanner
      image={image}
      headline={title}
      headlineAr={titleAr}
      subtitle={subtitle}
      subtitleAr={subtitleAr}
      ctaText={ctaText}
      ctaTextAr={ctaTextAr}
      ctaHref={ctaLink}
      isRtl={isRtl}
      urlPrefix={urlPrefix}
    />
  );
}
