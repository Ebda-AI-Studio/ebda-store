'use client';

import { useRef } from 'react';
import { cn } from '@ebda/ui';

type Props<T extends string> = {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
  disabled?: boolean;
};

/** Radio-group segmented control: arrow keys move, Tab leaves, RTL-safe (logical order). */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: Props<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5"
    >
      {options.map((o, idx) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o.value)}
            ref={el => {
              refs.current[idx] = el;
            }}
            onKeyDown={e => {
              const rtl = document.dir === 'rtl';
              let next = -1;
              if (e.key === 'ArrowRight') next = idx + (rtl ? -1 : 1);
              else if (e.key === 'ArrowLeft') next = idx + (rtl ? 1 : -1);
              else if (e.key === 'ArrowDown') next = idx + 1;
              else if (e.key === 'ArrowUp') next = idx - 1;
              else if (e.key === 'Home') next = 0;
              else if (e.key === 'End') next = options.length - 1;
              else return;
              e.preventDefault();
              next = (next + options.length) % options.length;
              onChange(options[next].value);
              refs.current[next]?.focus();
            }}
            className={cn(
              'h-9 min-w-[3.5rem] rounded-md px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:opacity-50',
              on
                ? 'bg-card font-semibold text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
