import { useEffect, useState } from 'react';

/**
 * Returns `value` after `delayMs` of stillness. Used to debounce
 * search-as-you-type inputs without coupling the input's controlled
 * state to the consumer (e.g. an API call).
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
