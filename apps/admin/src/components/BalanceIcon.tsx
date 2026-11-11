/** The "balance languages" glyph: a scale, an SVG that follows the text colour (admin has no emoji in UI). */
export function BalanceIcon({
  className = 'inline-block h-4 w-4 shrink-0',
}: {
  className?: string;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3v18M7 21h10M5 7h14M5 7l-3 7a3 3 0 0 0 6 0L5 7zm14 0l-3 7a3 3 0 0 0 6 0l-3-7z" />
    </svg>
  );
}
