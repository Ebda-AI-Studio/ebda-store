// The blog index is already a pure client shell (fetches via `useStore()`,
// zero server-side Dynamic-API dependency) — plan §3.3 explicitly calls
// this out as needing no resolver swap. Re-export it as-is for Track-A;
// see docs/plans/2026-07-12-tenant-cacheable-routing.md §3.6/§9.
export { default } from '@/app/blog/page';
