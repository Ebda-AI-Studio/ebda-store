'use client';

import Image from 'next/image';
import { useT } from '@/i18n/useT';

interface MultiImageGridProps {
  values: string[];
  onMove: (from: number, to: number) => void;
  onRemove: (index: number) => void;
}

/**
 * Grid of thumbnails for the MultiImageUpload widget, with reorder and
 * remove controls and a "main" badge on the first image.
 */
export function MultiImageGrid({ values, onMove, onRemove }: MultiImageGridProps) {
  const t = useT('components.imageUpload');

  if (values.length === 0) return null;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 mb-4">
      {values.map((url, i) => (
        <div
          key={url}
          className="relative group aspect-square rounded-lg border bg-muted overflow-hidden"
        >
          <Image src={url} alt={t('imageAlt', { index: i + 1 })} fill className="object-cover" />
          {i === 0 && (
            <span className="absolute top-1 start-1 bg-primary text-white text-[10px] font-medium px-1.5 py-0.5 rounded">
              {t('main')}
            </span>
          )}
          {/*
            Controls are ALWAYS visible below the md breakpoint and hover-gated
            above it. They used to be `opacity-0 group-hover:opacity-100` at
            every width, and a touch device has no hover state — so reordering
            and removing images was unreachable on mobile entirely. That also
            made the 44px `.touch-target` sizing self-defeating: the buttons
            were enlarged for exactly the devices that could never reveal them.
            768px is the same breakpoint `.touch-target` itself switches on.

            The dark scrim stays hover-only: on mobile the buttons carry their
            own white / destructive fills and a shadow, so they read against the
            thumbnail without dimming the image the merchant is trying to see.

            `flex-wrap` because three 44px circles plus two 4px gaps is 140px,
            and a `grid-cols-2` cell is ~138px wide on a 320px viewport — they
            overflowed the thumbnail rather than wrapping. Two rows of 44px fit
            an aspect-square cell at that width.
          */}
          <div className="absolute inset-0 md:bg-black/0 md:group-hover:bg-black/30 transition-colors flex flex-wrap items-center justify-center gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100">
            {i > 0 && (
              <button
                type="button"
                onClick={() => onMove(i, i - 1)}
                className="touch-target bg-white rounded-full shadow"
                title={t('moveLeft')}
                aria-label={t('moveLeft')}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 19l-7-7 7-7"
                  />
                </svg>
              </button>
            )}
            {i < values.length - 1 && (
              <button
                type="button"
                onClick={() => onMove(i, i + 1)}
                className="touch-target bg-white rounded-full shadow"
                title={t('moveRight')}
                aria-label={t('moveRight')}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 5l7 7-7 7"
                  />
                </svg>
              </button>
            )}
            <button
              type="button"
              onClick={() => onRemove(i)}
              className="touch-target bg-destructive text-white rounded-full shadow"
              title={t('remove')}
              aria-label={t('remove')}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
