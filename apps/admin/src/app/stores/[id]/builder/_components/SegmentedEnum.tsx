'use client';

/**
 * A choice of a few named options as one segmented control (editor premium F52): radio semantics,
 * arrow keys move and pick, only the picked segment is in the Tab order. For lists too long to read
 * at a glance the panel keeps a native select instead.
 */
import { rovingKeyDown } from '../_lib/roving';

export interface SegmentOption {
  value: string | number | boolean;
  label: string;
}

/** Up to this many options read as a segmented control; more stay a select. */
export const SEGMENTED_MAX = 4;

export function SegmentedEnum({
  label,
  options,
  value,
  onPick,
  describedBy,
  invalid,
  testId,
}: {
  label: string;
  options: readonly SegmentOption[];
  /** The value that is currently in effect (the stored one, else the default), if any. */
  value: unknown;
  onPick: (v: SegmentOption['value']) => void;
  describedBy?: string;
  invalid?: boolean;
  testId?: string;
}) {
  const at = options.findIndex(o => String(o.value) === String(value));
  const tabbable = at >= 0 ? at : 0;
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      onKeyDown={e => rovingKeyDown(e, 'radio')}
      className={`flex w-full gap-0.5 rounded-md bg-muted p-0.5 ${invalid ? 'ring-1 ring-destructive' : ''}`}
      data-testid={testId}
    >
      {options.map((o, i) => {
        const on = i === at;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={i === tabbable ? 0 : -1}
            title={o.label}
            onClick={() => onPick(o.value)}
            className={`h-8 min-w-0 flex-1 truncate rounded-md px-1.5 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none ${
              on ? 'bg-card text-primary-ink shadow-sm' : 'text-muted-ink hover:text-foreground'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
