'use client';

interface HelpTipProps {
  /** The explanatory text shown in the browser tooltip and aria-label. */
  text: string;
}

/**
 * Small circular "i" badge that surfaces contextual help inline next to a
 * label. Uses the native `title` attribute for accessibility; no external
 * dependency required.
 *
 * Pattern extracted from the ai-tools ReplaceCheckbox tooltip (2026-06-01).
 */
export function HelpTip({ text }: HelpTipProps) {
  return (
    <span
      title={text}
      aria-label={text}
      className="flex h-4 w-4 cursor-help items-center justify-center rounded-full bg-muted text-[10px] font-bold text-muted-foreground"
    >
      {/* i18n-gate-allow: info glyph, not copy */}i
    </span>
  );
}
