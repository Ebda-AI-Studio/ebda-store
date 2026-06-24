'use client';

/**
 * Shared RTL-aware text resolution hook used by EmptyState across all themes.
 *
 * Centralises the identical isRtl + displayTitle/description/cta logic that
 * was previously duplicated in every theme's EmptyState.tsx.
 */

import { useLanguage } from '../../contexts/LanguageContext';
import type { EmptyStateProps } from '../types';

export interface RtlTextResult {
  isRtl: boolean;
  displayTitle: string | undefined;
  displayDescription: string | undefined;
  displayCta: string | undefined;
}

/**
 * Resolve RTL-aware display strings for EmptyState props.
 *
 * - `isRtlProp` from the component prop takes precedence over context.
 * - When RTL is active, the Arabic variant is preferred; falls back to the
 *   default variant when the Arabic string is absent.
 * - When LTR is active, the default variant is preferred; falls back to the
 *   Arabic variant when the default is absent (matches the original per-theme
 *   fallback order exactly).
 */
export function useRtlText({
  title,
  titleAr,
  description,
  descriptionAr,
  ctaLabel,
  ctaLabelAr,
  isRtl: isRtlProp,
}: Pick<
  EmptyStateProps,
  'title' | 'titleAr' | 'description' | 'descriptionAr' | 'ctaLabel' | 'ctaLabelAr' | 'isRtl'
>): RtlTextResult {
  const { isRtl: ctxIsRtl } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;

  return {
    isRtl,
    displayTitle: isRtl ? (titleAr ?? title) : (title ?? titleAr),
    displayDescription: isRtl ? (descriptionAr ?? description) : (description ?? descriptionAr),
    displayCta: isRtl ? (ctaLabelAr ?? ctaLabel) : (ctaLabel ?? ctaLabelAr),
  };
}
