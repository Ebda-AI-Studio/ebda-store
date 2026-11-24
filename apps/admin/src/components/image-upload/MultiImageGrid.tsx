'use client';

import { Button } from '@/components/ui/Button';
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
            <span className="absolute top-1 start-1 bg-primary text-primary-foreground text-xs font-medium px-1.5 py-0.5 rounded-md">
              {t('main')}
            </span>
          )}
          {/*
            Controls stay ALWAYS visible on any device with no real hover
            input and hover-gated only where `(hover: hover) and
            (pointer: fine)` actually holds (`.hover-reveal` /
            `.hover-reveal-scrim`, globals.css). They used to be
            `opacity-0 group-hover:opacity-100` at every width, and a touch
            device has no hover state — so reordering and removing images
            was unreachable on mobile entirely. A later `md:` viewport-width
            gate "fixed" phones but broke touch tablets at >=768px the same
            way (issue #1356) — capability, not width, is the right gate.

            The dark scrim stays hover-only: on a device with no hover the
            buttons carry their own white / destructive fills and a shadow,
            so they read against the thumbnail without dimming the image the
            merchant is trying to see.

            `flex-wrap` because three 44px circles plus two 4px gaps is 140px,
            and a `grid-cols-2` cell is ~138px wide on a 320px viewport — they
            overflowed the thumbnail rather than wrapping. Two rows of 44px fit
            an aspect-square cell at that width.
          */}
          <div className="absolute inset-0 hover-reveal-scrim hover-reveal transition-colors flex flex-wrap items-center justify-center gap-1">
            {i > 0 && (
              <Button
                variant="outline"
                size="icon-sm"
                type="button"
                onClick={() => onMove(i, i - 1)}
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
              </Button>
            )}
            {i < values.length - 1 && (
              <Button
                variant="outline"
                size="icon-sm"
                type="button"
                onClick={() => onMove(i, i + 1)}
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
              </Button>
            )}
            <Button
              variant="destructive"
              size="icon-sm"
              type="button"
              onClick={() => onRemove(i)}
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
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
