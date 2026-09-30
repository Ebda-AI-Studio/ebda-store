import { useCallback, useRef } from 'react';

/**
 * Last-writer-wins guard for list fetches (issue 2234). `begin()` claims a
 * request slot and returns `isLatest()`; a response whose request is no
 * longer the newest must not overwrite state — two in-flight list requests
 * (a filter change, a page reset) otherwise resolve in either order and the
 * OLDER one can land last, painting its rows under the newer filter.
 * Same shape as useFeatures' `requestSeq`.
 */
export function useLatestRequest(): () => () => boolean {
  const seq = useRef(0);
  return useCallback(() => {
    const mine = ++seq.current;
    return () => mine === seq.current;
  }, []);
}
