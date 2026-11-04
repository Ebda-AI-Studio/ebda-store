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
      title={paused ? labels.play : labels.pause}
      className={`group/pause z-20 inline-flex h-11 w-11 items-center justify-center focus-visible:outline-none ${className}`}
    >
      {/* PREMIUM-3: a 28px round disc inside the 44px target (it was a 44px grey square). White glyph
          on a 55% black scrim keeps >= 4.5:1 over any photo; the ring shows on keyboard focus. */}
      <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm transition-colors group-hover/pause:bg-black/70 group-focus-visible/pause:ring-2 group-focus-visible/pause:ring-white">
        <svg className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          {paused ? <path d="M8 5v14l11-7z" /> : <path d="M7 5h4v14H7zM13 5h4v14h-4z" />}
        </svg>
      </span>
    </button>
  );
}
