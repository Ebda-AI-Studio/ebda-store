import { cn } from '@ebda/ui';

/** The "AI helper" glyph (UX:C-8): an SVG, so it follows the text colour instead of an emoji's own colours. */
export function SparkleIcon({ className }: { className?: string }) {
  return (
    <svg
      className={cn('inline-block h-4 w-4 shrink-0 align-[-2px]', className)}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8L12 2zm6 11l.9 2.6 2.6.9-2.6.9L18 20l-.9-2.6-2.6-.9 2.6-.9L18 13z" />
    </svg>
  );
}
