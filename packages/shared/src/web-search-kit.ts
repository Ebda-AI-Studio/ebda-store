/**
 * Entry point to the vendored shared search hooks (`./foundation/web/search`, byte-pinned by foundation.lock.json): `useLiveSearch`,
 * `useListboxNav`, `highlightSegments` (Ruling FDN-SEARCH-1). `@ebda/ui` re-exports them as `./search`. Needs `react` from the importing app.
 */
export * from './foundation/web/search';
