/**
 * The D1 settle lease (Ruling NZ-10-2): while a success is being applied, the ledger row's `failure_reason` holds this
 * marker and its `updated_at` is fresh; it expires after SETTLE_LEASE_MS. Shared by the settle itself and by the add-on
 * term chain, which must tell "failed for good" from "being settled right now".
 */
export const SETTLE_LEASE = 'settling';
export const SETTLE_LEASE_MS = 120_000;
