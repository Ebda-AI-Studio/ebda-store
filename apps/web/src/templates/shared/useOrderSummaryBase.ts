'use client';

/**
 * Shared computed-value hook for OrderSummary across all themes.
 *
 * The 5 theme OrderSummary components share identical preamble logic:
 * fmt, ctaText, summaryLabelBold, labelColorStyle, totalColorStyle.
 * Each theme keeps its own container / heading / row / CTA JSX — only
 * the derived values move here. This avoids touching any visual class.
 */

import { useLanguage } from '../../contexts/LanguageContext';
import { useNumerals } from '../../hooks/useNumerals';
import { formatTaxRowLabel } from '../../lib/tax-display';
import type { OrderSummaryProps } from '../types';

export interface OrderSummaryBaseResult {
  isRtl: boolean;
  /** Format a fils-denominated price as "X.XXX KWD" */
  fmt: (fils: number) => string;
  /** RTL-resolved CTA label */
  ctaText: string | undefined;
  /** Whether label text should render bold (default true) */
  summaryLabelBold: boolean;
  /** Inline style for label elements when a custom label colour is set */
  labelColorStyle: React.CSSProperties | undefined;
  /** Inline style for total elements when a custom total colour is set */
  totalColorStyle: React.CSSProperties | undefined;
  /** "VAT (5%)" / "Incl. VAT (5%)", bilingual. Undefined when there's no
   *  tax to show (rate 0, tax disabled, or `tax` is 0) — render nothing. */
  taxLabel: string | undefined;
}

/**
 * Derive the shared computed values needed by every OrderSummary theme.
 * Call this at the top of each theme's OrderSummary component and
 * destructure the result directly into your JSX.
 */
export function useOrderSummaryBase({
  currency = 'KWD',
  ctaLabel,
  ctaLabelAr,
  summaryColors,
  isRtl: isRtlProp,
  tax,
  taxRatePercent,
  taxIncludedInPrice,
}: Pick<
  OrderSummaryProps,
  | 'currency'
  | 'ctaLabel'
  | 'ctaLabelAr'
  | 'summaryColors'
  | 'isRtl'
  | 'tax'
  | 'taxRatePercent'
  | 'taxIncludedInPrice'
>): OrderSummaryBaseResult {
  const { isRtl: ctxIsRtl } = useLanguage();
  const { localize } = useNumerals();
  const isRtl = isRtlProp ?? ctxIsRtl;

  return {
    isRtl,
    fmt: (p: number) => `${localize((p / 1000).toFixed(3))} ${currency}`,
    ctaText: isRtl ? (ctaLabelAr ?? ctaLabel) : (ctaLabel ?? ctaLabelAr),
    summaryLabelBold: summaryColors?.bold !== false,
    labelColorStyle: summaryColors?.labelColor ? { color: summaryColors.labelColor } : undefined,
    totalColorStyle: summaryColors?.totalColor ? { color: summaryColors.totalColor } : undefined,
    taxLabel: formatTaxRowLabel(
      tax ?? 0,
      taxRatePercent ?? 0,
      !!taxIncludedInPrice,
      isRtl,
      localize
    ),
  };
}
