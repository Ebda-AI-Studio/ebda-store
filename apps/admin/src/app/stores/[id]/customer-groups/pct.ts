/** "12.5" -> 1250 basis points; null when it is not a number in [0, 90] with at most 2 decimals. */
export function pctToBps(raw: string): number | null {
  const s = raw.trim().replace(',', '.');
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(s)) return null;
  const bps = Math.round(Number(s) * 100);
  return bps >= 0 && bps <= 9000 ? bps : null;
}
