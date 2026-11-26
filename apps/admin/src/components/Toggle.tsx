/**
 * Admin switch (role="switch"). Off = dark neutral track, on = Ebda gold
 * track with a check in the knob, so state never relies on colour alone.
 * Track vs card contrast is >= 3:1 in both states (WCAG 1.4.11); the knob
 * travels towards the end edge in LTR and RTL.
 */
export function Toggle({
  checked,
  onChange,
  disabled,
  id,
  label,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledby,
  'aria-describedby': ariaDescribedby,
}: {
  checked: boolean;
  onChange: (val: boolean) => void;
  disabled?: boolean;
  id?: string;
  /** Accessible name (WCAG 4.1.2), shorthand for `aria-label`: what the switch turns on, in the page's words. */
  label?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label ?? ariaLabel}
      aria-labelledby={ariaLabelledby}
      aria-describedby={ariaDescribedby}
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 max-sm:before:absolute max-sm:before:-inset-y-2.5 max-sm:before:inset-x-0 max-sm:before:content-[''] ${
        checked ? 'bg-primary' : 'bg-muted-foreground'
      }`}
    >
      <span
        className={`pointer-events-none inline-flex h-4 w-4 transform items-center justify-center rounded-full bg-white shadow transition-transform motion-reduce:transition-none ${
          checked ? 'translate-x-6 rtl:-translate-x-6' : 'translate-x-1 rtl:-translate-x-1'
        }`}
      >
        {checked && (
          <svg
            viewBox="0 0 12 12"
            className="h-2.5 w-2.5 text-primary-ink"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path d="M2.5 6.5l2.2 2.2L9.5 3.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
    </button>
  );
}
