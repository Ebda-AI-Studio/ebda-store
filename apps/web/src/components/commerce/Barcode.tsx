/**
 * A barcode-LOOKING strip for the order receipt, built deterministically from
 * the order number: the same order always draws the same bars.
 *
 * NOT SCANNABLE (Ruling B0-3). It only looks like Code-128: each character is
 * hashed into three bar/space pairs of width 1-3. A real encoder would need a
 * dependency and buys nothing until the orders app scans receipts. Cost if
 * wrong: swapping in a real Code-128 encoder inside this one component.
 *
 * Decorative only (`aria-hidden`): the `#orderNumber` caption the receipt
 * renders under it is the accessible, copyable text.
 */
const GUARD = [2, 1, 1, 2, 3, 2];

function barWidths(value: string): number[] {
  const widths = [...GUARD];
  let h = 2166136261;
  for (const ch of value) {
    h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    for (let i = 0; i < 6; i++) widths.push(((h >>> (i * 3)) % 3) + 1);
  }
  return widths.concat(GUARD.slice().reverse(), [2]);
}

export function Barcode({ value, className }: { value: string; className?: string }) {
  const widths = barWidths(value);
  const rects: Array<{ x: number; w: number }> = [];
  let x = 0;
  widths.forEach((w, i) => {
    if (i % 2 === 0) rects.push({ x, w });
    x += w;
  });
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className={className}
      viewBox={`0 0 ${x} 40`}
      preserveAspectRatio="none"
      shapeRendering="crispEdges"
      data-testid="receipt-barcode"
    >
      {rects.map(r => (
        <rect key={r.x} x={r.x} y={0} width={r.w} height={40} fill="currentColor" />
      ))}
    </svg>
  );
}
