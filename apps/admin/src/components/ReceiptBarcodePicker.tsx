'use client';

import { useMemo, useState } from 'react';
import { RECEIPT_BARCODE_SHAPES, BARCODE_SHAPE_CREDIT, renderBarcodeSvg } from '@ebda/shared';
import { apiPut } from '../lib/api';
import { useT } from '@/i18n/useT';

const SAMPLE = 'ORD-48213';

/** Live preview: a real, scannable Code 128 of a sample number in that shape. */
function Preview({ shape }: { shape: string }) {
  const svg = useMemo(() => renderBarcodeSvg({ value: SAMPLE, shape, label: false }), [shape]);
  return (
    <bdi dir="ltr" className="block">
      <span
        aria-hidden="true"
        className="block text-foreground [&>svg]:mx-auto [&>svg]:h-16 [&>svg]:w-auto"
        // Built by our own encoder from a constant; nothing user-supplied.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </bdi>
  );
}

/**
 * Pick how the order barcode prints on the receipt, packing slip and invoice:
 * plain bars, a decorative shape (still a real Code 128 scan zone), or off.
 * Saves ONLY this key (the server merges `settings` shallowly), then tells the
 * page so its own full-settings save never re-sends a stale value.
 */
export function ReceiptBarcodePicker({
  storeId,
  value,
  onSaved,
}: {
  storeId: string;
  value: string | undefined;
  onSaved: (shape: string) => void;
}) {
  const t = useT('receiptBarcode');
  const [choice, setChoice] = useState(value ?? 'plain');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const options = ['plain', 'off', ...RECEIPT_BARCODE_SHAPES];

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const { error } = await apiPut(`/api/v1/stores/${storeId}`, {
        settings: { receiptBarcodeShape: choice },
      });
      if (error) setMsg({ ok: false, text: error.message || t('failed') });
      else {
        onSaved(choice);
        setMsg({ ok: true, text: t('saved') });
      }
    } catch {
      setMsg({ ok: false, text: t('failed') });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-3 rounded-xl border bg-card p-4 shadow-sm">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('hint')}</p>
      </div>
      <div
        role="radiogroup"
        aria-label={t('title')}
        className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4"
      >
        {options.map(id => {
          const on = choice === id;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setChoice(id)}
              className={`flex flex-col items-center gap-1 rounded-lg border p-2 text-xs ${
                on
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border bg-background text-muted-foreground hover:bg-muted'
              }`}
            >
              <span className="flex h-16 w-full items-center justify-center">
                {id === 'off' ? (
                  <span className="text-muted-foreground">-</span>
                ) : (
                  <Preview shape={id} />
                )}
              </span>
              <span className="font-medium">{t(`shape.${id}`)}</span>
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving || choice === (value ?? 'plain')}
          className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-40"
        >
          {t('saveShape')}
        </button>
        {msg && (
          <span
            role="status"
            className={`text-xs ${msg.ok ? 'text-success-ink' : 'text-destructive-ink'}`}
          >
            {msg.text}
          </span>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">{BARCODE_SHAPE_CREDIT}</p>
    </section>
  );
}
