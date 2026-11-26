'use client';

interface ToggleSwitchProps {
  enabled: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Accessible name (WCAG 4.1.2). */
  label: string;
}

export function ToggleSwitch({ enabled, onChange, disabled, label }: ToggleSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      onClick={() => !disabled && onChange(!enabled)}
      disabled={disabled}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed max-sm:before:absolute max-sm:before:-inset-y-2.5 max-sm:before:inset-x-0 max-sm:before:content-[''] ${
        enabled ? 'bg-primary' : 'bg-muted'
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
          enabled ? 'translate-x-5 rtl:-translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  );
}
