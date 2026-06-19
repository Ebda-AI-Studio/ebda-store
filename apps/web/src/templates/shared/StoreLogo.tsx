'use client';

import Image from 'next/image';
import { useState } from 'react';
import { useStore } from '../../contexts/StoreContext';

type LogoSize = 'auto' | 'sm' | 'md' | 'lg';

/**
 * Per-store multiplier on the base bounding box. `auto` lets the measured
 * aspect ratio drive the shape (mult = 1); sm/md/lg let a merchant nudge their
 * own logo without touching any other store (the old shared Tailwind class made
 * shrinking one store's logo shrink every store's).
 */
const SIZE_MULT: Record<Exclude<LogoSize, 'auto'>, number> = { sm: 0.82, md: 1, lg: 1.22 };

/**
 * Base bounding box (the platform default before this component): mobile h-14
 * (56px) / desktop h-20 (80px); max width mobile 150 / desktop 210. The logo is
 * `object-contain`-fitted inside this box, so it NEVER breaks the header row —
 * the box only ever shrinks the logo, never stretches it.
 */
const BASE = { hMobile: 56, hDesktop: 80, wMobile: 150, wDesktop: 210 };

/**
 * Adaptive store logo for the 5 theme headers.
 *
 * Replaces the hardcoded shared `<Image className="h-14 max-w-[150px] …">`. Two
 * wins over that fixed class:
 *  1. Per-store sizing via `theme.logoSize` (auto/sm/md/lg) — decoupled, so one
 *     store's logo size never affects another.
 *  2. Auto-fit by the logo's measured aspect ratio: very wide wordmarks would
 *     otherwise clamp to the width cap well BELOW the height cap and render
 *     tiny, so we grant them more width (up to a hard clamp) to render closer to
 *     full height. Square/tall logos use the base box unchanged.
 *
 * Responsive sizes are emitted as CSS variables consumed by the `.store-logo`
 * utility in globals.css (inline styles can't carry a media query). SSR renders
 * the base box (no aspect yet) → no layout flash for the common case.
 */
export function StoreLogo({
  src,
  alt,
  invert = false,
  priority,
}: {
  src: string;
  alt: string;
  /** Bold theme renders the logo solid-white via brightness(0) invert(1). */
  invert?: boolean;
  priority?: boolean;
}) {
  const { store } = useStore();
  const size = (store.theme?.logoSize as LogoSize | undefined) ?? 'auto';
  const [aspect, setAspect] = useState<number | null>(null);

  const mult = size === 'auto' ? 1 : SIZE_MULT[size];

  // Wide wordmarks (aspect > 2.6 — e.g. a long horizontal logo) hit the width
  // cap before the height cap, rendering short and small. Grant up to 1.6× width
  // (hard-clamped) so they render closer to the full height. Anything ≤ 2.6
  // (square/portrait/mild-landscape) is unaffected.
  const widthBoost = aspect && aspect > 2.6 ? Math.min(aspect / 2.6, 1.6) : 1;

  const styleVars = {
    '--logo-mh': `${Math.round(BASE.hMobile * mult)}px`,
    '--logo-mh-d': `${Math.round(BASE.hDesktop * mult)}px`,
    '--logo-mw': `${Math.round(BASE.wMobile * mult * widthBoost)}px`,
    '--logo-mw-d': `${Math.round(BASE.wDesktop * mult * widthBoost)}px`,
  } as React.CSSProperties;

  return (
    <Image
      src={src}
      alt={alt}
      width={320}
      height={120}
      priority={priority}
      onLoad={e => {
        const img = e.currentTarget;
        if (img.naturalWidth && img.naturalHeight) {
          setAspect(img.naturalWidth / img.naturalHeight);
        }
      }}
      className={`store-logo${invert ? ' brightness-0 invert' : ''}`}
      style={styleVars}
    />
  );
}
