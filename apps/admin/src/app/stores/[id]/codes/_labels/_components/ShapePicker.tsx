'use client';

import { BARCODE_SHAPE_CREDIT, RECEIPT_BARCODE_SHAPES, type ShapePrintability } from '@ebda/shared';
import { BarcodeStyleGrid, BarcodeStyleTile } from '@/components/BarcodeStyleTile';
import { useT } from '@/i18n/useT';

const SAMPLE = '2000000000015';

/** Plain bars + the 24 BARKOD shapes (always a real Code 128 scan zone). */
export function ShapePicker({
  value,
  onChange,
  printability,
  heightMm,
}: {
  value: string;
  onChange: (shape: string) => void;
  /** Per-shape printability on the CURRENT label size; a missing entry means printable. */
  printability?: Record<string, ShapePrintability>;
  /** Current label height, mm (for the "your label is Y mm" line). */
  heightMm?: number;
}) {
  const t = useT('receiptBarcode');
  const tl = useT('labels.shape');
  const have = heightMm === undefined ? '' : String(Math.round(heightMm * 10) / 10);
  const blocked = Object.entries(printability ?? {}).filter(([, v]) => !v.printable);
  const heights = blocked.map(([, v]) => v.minHeightMm).filter((n): n is number => n !== null);
  const minAll = heights.length ? Math.min(...heights) : null;
  return (
    <div className="space-y-2">
      <BarcodeStyleGrid label={tl('title')} className="max-h-72 overflow-auto">
        {['plain', ...RECEIPT_BARCODE_SHAPES].map(id => {
          const p = printability?.[id];
          const bad = p && !p.printable ? p : null;
          const reason = bad
            ? bad.minHeightMm !== null
              ? tl('needsHeightTile', { min: String(bad.minHeightMm), have })
              : tl('needsWidthTile')
            : undefined;
          return (
            <BarcodeStyleTile
              key={id}
              id={id}
              name={t(`shape.${id}`)}
              sample={SAMPLE}
              selected={value === id}
              blockedReason={reason}
              onSelect={() => onChange(id)}
            />
          );
        })}
      </BarcodeStyleGrid>
      {blocked.length > 0 && (
        <p className="text-xs font-medium text-foreground">
          {minAll !== null ? tl('needsHeight', { min: String(minAll), have }) : tl('needsWidth')}
        </p>
      )}
      <p className="text-xs text-muted-foreground">{tl('hint')}</p>
      <p className="text-xs text-muted-foreground">{BARCODE_SHAPE_CREDIT}</p>
    </div>
  );
}
