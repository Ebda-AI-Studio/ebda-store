'use client';

import type { CSSProperties } from 'react';
import { pickReadableForeground } from '@ebda/shared';
import { useT } from '@/i18n/useT';
import type { StoreTheme } from './types';

interface BrandPreviewProps {
  theme: StoreTheme;
}

/**
 * Live preview of theme colors on representative UI elements.
 * Uses inline CSS variables so the preview is scoped and does not
 * mutate the global admin theme.
 */
export function BrandPreview({ theme }: BrandPreviewProps) {
  const t = useT('branding.preview');
  // K-02 (review N2): the ink the storefront derives for this colour, not a fixed white.
  const ink = pickReadableForeground(theme.primaryColor) ?? '#ffffff';

  return (
    <div className="mt-8 pt-6 border-t">
      <h3 className="text-sm font-medium text-foreground mb-4">{t('title')}</h3>
      <div
        className="p-6 bg-muted rounded-md"
        style={{ '--primary': theme.primaryColor } as CSSProperties}
      >
        <div className="flex items-center gap-4 mb-4">
          <button
            data-ui="swatch"
            type="button"
            className="px-4 py-2 rounded-lg"
            style={{ backgroundColor: `hsl(${theme.primaryColor})`, color: ink }}
          >
            {t('primaryButton')}
          </button>
          <button
            data-ui="swatch"
            type="button"
            className="px-4 py-2 border border-border rounded-lg hover:bg-muted"
          >
            {t('secondaryButton')}
          </button>
        </div>
        <p style={{ color: `hsl(${theme.primaryColor})` }}>{t('sampleText')}</p>
      </div>
    </div>
  );
}
