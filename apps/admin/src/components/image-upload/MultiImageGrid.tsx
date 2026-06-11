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
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center gap-1 opacity-0 group-hover:opacity-100">
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
