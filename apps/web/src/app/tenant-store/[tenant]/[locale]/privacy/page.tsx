// Zero store-resolver dependency in the legacy page (no `getStore()` call
// server-side) — plan §4 notes these may not need to move at all. Re-export
// the same client shell for Track-A. See
// docs/plans/done/2026-07-12-tenant-cacheable-routing.md §3.6/§9.
export { generateMetadata, default } from '@/app/privacy/page';
