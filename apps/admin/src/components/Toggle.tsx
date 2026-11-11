/**
 * Page-local switch used next to each carrier's "enabled" and
 * "isDefault" controls. Stays here rather than moving into @ebda/ui
 * because it's tuned for the carrier-settings card and has no other
 * callers.
 */
export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (val: boolean) => void;
  disabled?: boolean;
  /** The switch's accessible name (WCAG 4.1.2): what it turns on, in the page's words. Required: a nameless switch is a defect. */
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:opacity-50 max-sm:before:absolute max-sm:before:-inset-y-2.5 max-sm:before:inset-x-0 max-sm:before:content-[''] ${
        checked ? 'bg-primary' : 'bg-muted'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-6 rtl:-translate-x-6' : 'translate-x-1 rtl:-translate-x-1'
        }`}
      />
    </button>
  );
}
