'use client';

import { useRef, type KeyboardEvent } from 'react';

export interface StatusFilterOption<T extends string = string> {
  value: T;
  label: string;
}

interface StatusFilterPillsProps<T extends string = string> {
  /** Accessible label for the whole pill group. */
  ariaLabel: string;
  /** Option list in render/focus order. */
  options: readonly StatusFilterOption<T>[];
  /** Currently selected value. */
  value: T;
  /** Change handler — fires when a pill is clicked or the focused pill receives Enter/Space. */
  onChange: (value: T) => void;
  /** Wrapper class applied to the container (for background/padding). */
  className?: string;
  /** Extra class applied to each pill button. */
  pillClassName?: string;
  /** Class merged into the pill when it's the active selection. */
  activeClassName?: string;
  /** Class merged into the pill when it's not selected. */
  inactiveClassName?: string;
}

/**
 * Keyboard-navigable status filter implemented as an ARIA radio group:
 * arrow keys move focus between pills, home/end jump to the ends, and only
 * the active pill is in the Tab sequence. Extracted from the products page
 * and the stores list to dedupe the same pattern.
 */
export function StatusFilterPills<T extends string = string>({
  ariaLabel,
  options,
  value,
  onChange,
  className = 'flex items-center gap-1 rounded-md bg-muted p-1',
  pillClassName = 'cursor-pointer rounded-lg px-3 min-h-11 md:min-h-8 inline-flex items-center text-xs font-medium capitalize transition-all duration-200',
  activeClassName = 'bg-card text-foreground shadow-sm',
  inactiveClassName = 'text-muted-foreground hover:text-foreground',
}: StatusFilterPillsProps<T>) {
  // Refs let arrow-key navigation move focus without re-rendering.
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);

  function focusIndex(idx: number) {
    const clamped = ((idx % options.length) + options.length) % options.length;
    buttonRefs.current[clamped]?.focus();
    const next = options[clamped];
    if (next && next.value !== value) onChange(next.value);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault();
        focusIndex(index + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault();
        focusIndex(index - 1);
        break;
      case 'Home':
        e.preventDefault();
        focusIndex(0);
        break;
      case 'End':
        e.preventDefault();
        focusIndex(options.length - 1);
        break;
      default:
        break;
    }
  }

  const hasActive = options.some(o => o.value === value);
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={className}>
      {options.map((option, index) => {
        const isActive = option.value === value;
        // Roving tabindex needs exactly ONE tabbable pill. If `value` matches
        // no option (a dynamic option list that dropped it), the first pill
        // takes the tab stop so the group stays keyboard-reachable (#2222).
        const tabbable = isActive || (!hasActive && index === 0);
        return (
          <button
            key={option.value}
            ref={el => {
              buttonRefs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={isActive}
            tabIndex={tabbable ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={e => handleKeyDown(e, index)}
            className={`${pillClassName} ${isActive ? activeClassName : inactiveClassName}`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
