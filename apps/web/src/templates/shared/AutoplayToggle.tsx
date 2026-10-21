'use client';

/**
 * Quality bar § 10 rule (e) (W4, WCAG 2.2.2): anything that moves on its own for more than 5s
 * (a looping hero video, an auto-advancing slider or carousel) carries this visible 44px
 * pause/play toggle. ONE pattern: the label flips Pause/Play (no `aria-pressed`: both together read
 * as "Play, pressed", STOP-2 a11y M1). The owner also pauses while focus is inside.
 */
export function AutoplayToggle({
  paused,
  onToggle,
  labels,
  className = '',
}: {
  paused: boolean;
  onToggle: () => void;
  labels: { pause: string; play: string };
  className?: string;
}) {
  return (
    <button
      type="button"
      data-autoplay-toggle
      aria-label={paused ? labels.play : labels.pause}
      onClick={onToggle}
      className={`z-20 inline-flex h-11 w-11 items-center justify-center rounded-[var(--radius)] bg-background/80 text-foreground hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${className}`}
    >
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        {paused ? <path d="M8 5v14l11-7z" /> : <path d="M7 5h4v14H7zM13 5h4v14h-4z" />}
      </svg>
    </button>
  );
}
