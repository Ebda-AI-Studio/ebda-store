import type { WordmarkSize } from '@ebda/shared';

/**
 * The text wordmark a look sizes (W2a, quality bar T-01): the store name leads the header at
 * >= 1.25x its largest other text (nav 14px), in the look's display face, never tracked or
 * uppercased (decision (a)), and the checkout/success header renders the SAME wordmark.
 * `lg` = 24px at every width (the Latin display face is never set under 24px); `xl` = 24 / 30px.
 * Only stores whose composed theme carries `wordmarkSize` (the Qamar looks) reach this; every
 * other store keeps its skin's own wordmark markup.
 */
export const WORDMARK_SIZE_CLASS: Record<WordmarkSize, string> = {
  lg: 'text-2xl',
  xl: 'text-2xl sm:text-3xl',
};

export function wordmarkClass(size: WordmarkSize): string {
  return `block max-w-full truncate font-display font-normal leading-normal tracking-normal normal-case text-foreground ${WORDMARK_SIZE_CLASS[size]}`;
}

/** Header nav links next to a sized wordmark: 14px, untracked, sentence case (T-01, decision (a)). */
export const WORDMARK_NAV_LINK_CLASS =
  'text-sm font-normal text-muted-foreground hover:text-foreground transition-colors duration-200';

/**
 * IA-09 (W4): the footer's text wordmark on a look store: the same display face as the header,
 * at 24px (the Latin display face is never set under 24px, decision (a)), never tracked.
 */
export const FOOTER_WORDMARK_CLASS =
  'font-display font-normal leading-normal tracking-normal normal-case text-2xl text-foreground';
