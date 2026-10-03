import { useCallback, useRef } from 'react';

/**
 * Last-writer-wins guard for list fetches (issue 2234). `begin()` claims a
 * request slot and returns `isLatest()`; a response whose request is no
 * longer the newest must not overwrite state — two in-flight list requests
 * (a filter change, a page reset) otherwise resolve in either order and the
 * OLDER one can land last, painting its rows under the newer filter.
 * Same shape as useFeatures' `requestSeq`.
 *
 * It orders by CALL time, not by intent: whichever request calls `begin()` last
 * wins, even a semantically stale one. It therefore does NOT protect against a
 * stale-closure caller — a post-action handler that calls a `fetchX` captured
 * from an old render (old page/filter) claims the newest slot and repaints
 * stale data (issue 2443). Callers must route every refetch through the single
 * fetch effect (action handlers bump a `refreshKey` that the effect depends on)
 * so each request is built from the CURRENT page/filter.
 */
export function useLatestRequest(): () => () => boolean {
  const seq = useRef(0);
  return useCallback(() => {
    const mine = ++seq.current;
    return () => mine === seq.current;
  }, []);
}
