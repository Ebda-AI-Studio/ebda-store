'use client';

import { useEffect, useState } from 'react';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { FIELD_CLASSES } from '@/components/ui/tokens';

interface SearchInputProps {
  /** The committed (debounced) value owned by the parent. */
  value: string;
  /** Fires with the debounced text after the user stops typing (150ms). */
  onSearch: (value: string) => void;
  placeholder: string;
  /** Extra classes for the wrapping element. */
  className?: string;
  /** aria-label; falls back to `placeholder` when omitted. */
  ariaLabel?: string;
}

/**
 * Debounced search box with a leading magnifier icon.
 *
 * Shared by the Products list filters and the Inventory page so both surfaces
 * get identical behaviour: a 150ms debounce (via `useDebouncedValue`), the same
 * icon, and the same styling. The parent owns the committed value while this
 * component holds the live keystrokes locally and only calls `onSearch` once
 * the debounce settles.
 */
export function SearchInput({
  value,
  onSearch,
  placeholder,
  className,
  ariaLabel,
}: SearchInputProps) {
  const [localValue, setLocalValue] = useState(value);
  const debounced = useDebouncedValue(localValue, 150);

  // Push the debounced value up only when it actually changed, so a re-render
  // driven by the parent doesn't loop back into another onSearch call.
  useEffect(() => {
    if (debounced !== value) {
      onSearch(debounced);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  // Keep the local box in sync if the parent resets the value externally.
  useEffect(() => {
    setLocalValue(value);
  }, [value]);

  return (
    <div className={`relative ${className ?? 'w-64'}`}>
      <svg
        className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
        />
      </svg>
      <input
        type="search"
        enterKeyHint="search"
        value={localValue}
        onChange={e => setLocalValue(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        className={FIELD_CLASSES}
      />
    </div>
  );
}
