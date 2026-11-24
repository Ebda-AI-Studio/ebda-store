'use client';

import { useState } from 'react';
import { useT } from '@/i18n/useT';

interface StoreAvatarProps {
  /** Store display name — used for the letter fallback + alt text. */
  name: string;
  /** Optional store logo URL (R2). Falls back to the letter monogram when
   *  absent or when the image fails to load. */
  logo?: string | null;
  /** Tailwind size + shape classes for the square avatar box. */
  className?: string;
}

/**
 * Square store avatar that prefers the store's uploaded logo and gracefully
 * falls back to a brand-tinted letter monogram. Used in the admin Stores list
 * (grid cards + table rows) so each store is recognizable by its own logo
 * instead of a generic first-letter chip.
 *
 * The logo is rendered with a plain <img> (not next/image) because store logos
 * are arbitrary R2 URLs — frequently SVG — and next/image's optimizer mishandles
 * SVG without `unoptimized`. object-contain on a white background keeps any
 * aspect ratio / transparent logo readable.
 */
export function StoreAvatar({ name, logo, className = '' }: StoreAvatarProps) {
  const t = useT('stores.avatar');
  const [errored, setErrored] = useState(false);
  const letter = name.charAt(0).toUpperCase();

  if (logo && !errored) {
    return (
      <div
        className={`flex items-center justify-center overflow-hidden rounded-lg border border-border bg-white ${className}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={logo}
          alt={t('logoAlt', { name })}
          className="h-full w-full object-contain p-1"
          loading="lazy"
          onError={() => setErrored(true)}
        />
      </div>
    );
  }

  return (
    <div
      className={`flex items-center justify-center rounded-lg bg-gradient-to-br from-primary/20 to-primary/5 font-bold text-primary ${className}`}
    >
      {letter}
    </div>
  );
}
