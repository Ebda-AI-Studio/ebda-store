/**
 * Reserved store slugs — the SINGLE source of truth is the vendored ebda-foundation (`slugs`, foundation.lock.json).
 * Signup, store create/update (API), the host parser and the resolver all import THIS re-export; never copy the list.
 */
export {
  RESERVED_SLUGS,
  isDemoShowroomSlug,
  isReservedSlug,
  type ReservedSlug,
} from '../foundation/slugs';
