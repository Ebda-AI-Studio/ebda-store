'use client';

import { useMemo } from 'react';
import {
  BARCODE_SHAPE_CREDIT,
  RECEIPT_BARCODE_SHAPES,
  renderBarcodeSvg,
  type ShapePrintability,
} from '@ebda/shared';
import { useT } from '@/i18n/useT';

const SAMPLE = '2000000000015';

/**
 * Every tile has the SAME box in every state. Selected / hover / focus only change colour and a
 * ring (box-shadow), never border width, padding or size, so picking a style cannot shift the grid.
 */
const TILE_LAYOUT =
  'relative flex min-w-0 flex-col items-center gap-1 rounded-lg border p-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50';
const TILE_STATE = {
  on: 'border-primary bg-primary/10 text-foreground ring-2 ring-primary/40',
  off: 'border-border bg-background text-muted-foreground hover:bg-muted',
  blocked: 'cursor-not-allowed border-border bg-muted/40 text-muted-foreground opacity-50',
} as const;
/** Art box: fixed height, clipped, and the SVG scales to fit inside (viewBox "meet"), never past it. */
const ART_BOX = 'flex h-14 w-full min-w-0 items-center justify-center overflow-hidden';
const ART_SVG = 'block h-full w-full text-foreground [&>svg]:h-full [&>svg]:w-full';

function Mini({ shape }: { shape: string }) {
  const svg = useMemo(() => renderBarcodeSvg({ value: SAMPLE, shape, label: false }), [shape]);
  return (
    <bdi dir="ltr" className="block h-full w-full">
      <span
        aria-hidden="true"
        className={ART_SVG}
        // Built by our own encoder from a constant; nothing user-supplied.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </bdi>
  );
}

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
      <div
        role="radiogroup"
        aria-label={tl('title')}
        className="grid max-h-72 grid-cols-[repeat(3,minmax(0,1fr))] gap-2 overflow-auto p-1 sm:grid-cols-[repeat(4,minmax(0,1fr))]"
      >
        {['plain', ...RECEIPT_BARCODE_SHAPES].map(id => {
          const on = value === id;
          const p = printability?.[id];
          const bad = p && !p.printable ? p : null;
          const off = !!bad;
          const reason = bad
            ? bad.minHeightMm !== null
              ? tl('needsHeightTile', { min: String(bad.minHeightMm), have })
              : tl('needsWidthTile')
            : undefined;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={on}
              aria-disabled={off && !on ? true : undefined}
              title={reason}
              aria-label={reason ? `${t(`shape.${id}`)}. ${reason}` : undefined}
              onClick={() => {
                if (!off || on) onChange(id);
              }}
              className={`${TILE_LAYOUT} ${on ? TILE_STATE.on : off ? TILE_STATE.blocked : TILE_STATE.off}`}
            >
              <span className={ART_BOX}>
                <Mini shape={id} />
              </span>
              <span className="w-full truncate text-center font-medium">{t(`shape.${id}`)}</span>
            </button>
          );
        })}
      </div>
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
