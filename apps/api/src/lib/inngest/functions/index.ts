/**
 * Registry of every Inngest function the API exposes. The serve
 * handler in `apps/api/src/index.ts` mounts this list at
 * `/api/v1/inngest`. Functions added here are picked up by the
 * Inngest platform on the next deploy / dev sync.
 *
 * Phase 4a intentionally ships with zero functions so the
 * infrastructure (client, signing key, mounted endpoint) lands as
 * its own commit. Subsequent phases (4b/4c/4d) add real handlers
 * for order notifications, bulk imports, and PDF invoices.
 */
export const inngestFunctions = [] as const;
