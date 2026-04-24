'use client';

import Image from 'next/image';
import { useT } from '@/i18n/useT';

interface UploadPreviewProps {
  value: string;
  alt: string;
  onRemove?: () => void;
  className?: string;
}

/**
 * Thumbnail for a single uploaded image with a hover-revealed remove button.
 * Used by single-image uploaders.
 */
export function UploadPreview({ value, alt, onRemove, className = '' }: UploadPreviewProps) {
  const t = useT('components.imageUpload');

  return (
    <div className={`relative group ${className}`}>
      <div className="rounded-lg border bg-muted p-3">
        <Image
          src={value}
          alt={alt}
          width={200}
          height={96}
          className="h-24 w-auto object-contain mx-auto"
        />
      </div>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="absolute top-1 end-1 p-1 bg-destructive text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
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
      )}
    </div>
  );
}
