/**
 * AI spend in micros of the store's billing currency → a readable amount.
 *
 * Deliberately 4 decimals: per-call AI spend is routinely a fraction of one
 * currency unit, and 2 decimals would render most real months as "0.00" —
 * the exact illusion the spend surfaces exist to remove. Shared by the
 * super-admin platform page and the per-store usage card/log so the two never
 * format the same number differently (issues 2204/2226).
 */
export function formatSpend(micros: number): string {
  const units = micros / 1_000_000;
  if (units === 0) return '0';
  if (units < 0.0001) return '<0.0001';
  return units.toLocaleString('en-GB', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}
