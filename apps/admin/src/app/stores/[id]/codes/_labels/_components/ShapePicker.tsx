'use client';

import { useMemo } from 'react';
import { BARCODE_SHAPE_CREDIT, RECEIPT_BARCODE_SHAPES, renderBarcodeSvg } from '@ebda/shared';
import { useT } from '@/i18n/useT';

const SAMPLE = '2000000000015';

function Mini({ shape }: { shape: string }) {
  const svg = useMemo(() => renderBarcodeSvg({ value: SAMPLE, shape, label: false }), [shape]);
  return (
    <bdi dir="ltr" className="block">
      <span
        aria-hidden="true"
        className="block text-foreground [&>svg]:mx-auto [&>svg]:h-14 [&>svg]:w-auto"
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
}: {
  value: string;
  onChange: (shape: string) => void;
}) {
  const t = useT('receiptBarcode');
  const tl = useT('labels.shape');
  return (
    <div className="space-y-2">
      <div
        role="radiogroup"
        aria-label={tl('title')}
        className="grid max-h-72 grid-cols-3 gap-2 overflow-auto sm:grid-cols-4"
      >
        {['plain', ...RECEIPT_BARCODE_SHAPES].map(id => {
          const on = value === id;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(id)}
              className={`flex flex-col items-center gap-1 rounded-lg border p-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${
                on
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border bg-background text-muted-foreground hover:bg-muted'
              }`}
            >
              <span className="flex h-14 w-full items-center justify-center">
                <Mini shape={id} />
              </span>
              <span className="font-medium">{t(`shape.${id}`)}</span>
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">{tl('hint')}</p>
      <p className="text-xs text-muted-foreground">{BARCODE_SHAPE_CREDIT}</p>
    </div>
  );
}
