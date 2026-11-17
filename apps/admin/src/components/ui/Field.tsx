'use client';

/**
 * The editor's ONE form-control vocabulary (plan docs/plans/2026-11-15-editor-premium-ux.md, finding F16, RC3).
 * Heights come from `CONTROL_HEIGHT` (44px on phones, 40px from `sm:` up), the radius is `rounded-md`, the label
 * sits above the control, the hint is one quiet line. Logical CSS only, so everything mirrors in Arabic.
 *
 * Layout inside a pane is decided by the pane, never by the window (Ruling EPUX-1): these primitives are
 * full-width blocks; a parent that wants two columns uses a container query (`@container` + `@xs:`), not `sm:`.
 */
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@ebda/ui/cn';

const CONTROL =
  'block h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 text-base text-foreground placeholder:text-muted-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 sm:h-10 sm:text-sm';

/** A drawn chevron (one stroke weight); points down, rotate it for "open". */
export function Chevron({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

export const fieldControlClasses = (extra?: string) => cn(CONTROL, extra);

/** Label above, control, then an optional one-line hint or an error (role=alert). */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium text-foreground">
        {label}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-xs text-destructive-ink">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs leading-5 text-muted-ink">{hint}</p>
      ) : null}
    </div>
  );
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...p }, ref) => (
    <input ref={ref} className={fieldControlClasses(className)} {...p} />
  )
);
TextInput.displayName = 'TextInput';

export interface SegmentOption {
  value: string;
  label: string;
  /** Icon-only option: the label becomes the accessible name and the tooltip. */
  icon?: ReactNode;
}

/**
 * A segmented choice (radio group). Native radios under the labels, so arrow keys, Home/End and RTL direction are
 * the browser's own. Options never clip: they sit in a wrapping row, each at least its content wide.
 */
export function Segmented({
  label,
  value,
  onChange,
  options,
  iconOnly = false,
  className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: SegmentOption[];
  iconOnly?: boolean;
  className?: string;
}) {
  const name = useId();
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn('flex flex-wrap gap-1 rounded-md bg-muted p-1', className)}
    >
      {options.map(o => {
        const on = o.value === value;
        return (
          <label
            key={o.value}
            title={iconOnly ? o.label : undefined}
            className={cn(
              'relative inline-flex h-9 min-w-9 flex-1 cursor-pointer select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors duration-150 motion-reduce:transition-none sm:h-8',
              'focus-within:ring-2 focus-within:ring-ring',
              on ? 'bg-card text-primary-ink shadow-sm' : 'text-muted-ink hover:text-foreground'
            )}
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={on}
              onChange={() => onChange(o.value)}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              aria-label={o.label}
            />
            {o.icon}
            {iconOnly ? null : <span>{o.label}</span>}
          </label>
        );
      })}
    </div>
  );
}
