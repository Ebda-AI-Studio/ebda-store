import { cn } from '@ebda/ui';

/**
 * An arrow that points toward the inline START edge: left in LTR, right in RTL (UX:R-1). Use it for "back"
 * affordances instead of a `←` / `→` glyph inside a translated string, which cannot flip with the direction.
 * `ArrowEnd` is its mirror, for "next" / "open".
 */
export function ArrowStart({ className }: { className?: string }) {
  return (
    <svg
      className={cn('h-4 w-4 shrink-0 rtl:rotate-180', className)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M19 12H5m0 0l6-6m-6 6l6 6" />
    </svg>
  );
}

export function ArrowEnd({ className }: { className?: string }) {
  return (
    <svg
      className={cn('h-4 w-4 shrink-0 rtl:rotate-180', className)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14m0 0l-6-6m6 6l-6 6" />
    </svg>
  );
}
