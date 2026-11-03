/**
 * Retention and PDPL erasure timing: ONE place (Rulings RETENTION-1, RETENTION-2; docs/plans/2026-11-02-neon-zero.md N-23/N-24).
 *
 * RETENTION_YEARS = 7 from the ORDER date. The legal minimum is 5 years (Egypt Law 206/2020 Art. 37 and Law 17/1999 Art. 26); two
 * years are added as a buffer for clocks that start late. Everything that keeps or purges a record for retention (the fiscal archive
 * `retain_until`, the closed-store purge job N-24) reads this constant, never its own number.
 *
 * PDPL erasure (Law 151/2020): an erasure request is ACKNOWLEDGED within 72 hours and COMPLETED within 7 days (RETENTION-2,
 * a conservative default). Records the law requires (invoices, VAT, payments, ETA e-invoices) are kept with the person's identity
 * removed; the Law 151/2020 legal-obligation exemption and the tax law above are the basis.
 */
export const RETENTION_YEARS = 7;
export const PDPL_ERASURE_ACK_HOURS = 72;
export const PDPL_ERASURE_COMPLETE_DAYS = 7;
