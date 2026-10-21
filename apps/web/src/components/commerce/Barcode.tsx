import { useId, useMemo } from 'react';
import { BARCODE_DISPLAY_PX, renderBarcodeSvg } from '@ebda/shared';

/**
 * The order receipt's barcode: a REAL, scannable Code 128 of the order number
 * (replaces the old look-alike strip, Ruling B0-3), optionally clipped into a
 * BARKOD-studio shape (`store.settings.receiptBarcodeShape`). Shape drawings:
 * BARKOD studio (barkod.studio), used with permission.
 *
 * Ink is `currentColor` (the receipt's near-black paper ink, never the brand
 * accent). The bars are LTR always, so the SVG sits in `<bdi dir="ltr">`
 * inside an RTL page. The caption under it carries the accessible number, so
 * this wrapper is `aria-hidden`. `off` (or an un-encodable number) draws nothing.
 */
export function Barcode({
  value,
  shape = 'plain',
  className,
}: {
  value: string;
  shape?: string | null;
  className?: string;
}) {
  const uid = useId();
  const svg = useMemo(() => {
    if (shape === 'off') return null;
    try {
      return renderBarcodeSvg({
        value,
        shape: shape ?? 'plain',
        label: false,
        idSuffix: uid,
        // Shapes that would put a module under 2 css px at the receipt width print plain.
        displayPx: BARCODE_DISPLAY_PX.storefrontReceipt,
      });
    } catch {
      return null; // a number Code 128 cannot carry: caption only
    }
  }, [value, shape, uid]);
  if (!svg) return null;
  return (
    <bdi dir="ltr" className={className}>
      <span
        aria-hidden="true"
        data-testid="receipt-barcode"
        data-shape={shape ?? 'plain'}
        className="block [&>svg]:h-auto [&>svg]:w-full"
        // The SVG is built from our own encoder; `value` is escaped in it.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </bdi>
  );
}
