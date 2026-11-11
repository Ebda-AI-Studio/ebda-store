'use client';

import Image from 'next/image';
import { useT } from '@/i18n/useT';
import { Button } from '@/components/ui/Button';

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
        <Button
          type="button"
          variant="destructive"
          size="icon-sm"
          onClick={onRemove}
          // Same defect class as MultiImageGrid: a hover-gated CONTROL is
          // unreachable on touch, where there is no hover state — so removing
          // an uploaded image was impossible on mobile. `hover-reveal` gates
          // on `(hover: hover) and (pointer: fine)` — input capability, not
          // viewport width — so it stays visible on a touch tablet at >=768px
          // too (issue #1356 found the old `md:` gate broke exactly that
          // device). `touch-target` replaces `p-1` (~24px) so the tap area
          // clears the 44px floor the rest of the admin uses.
          className="absolute top-1 end-1 hover-reveal"
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
      )}
    </div>
  );
}
