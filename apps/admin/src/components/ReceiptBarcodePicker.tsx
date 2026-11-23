'use client';

import { Button } from '@/components/ui/Button';
import { useEffect, useState } from 'react';
import {
  RECEIPT_BARCODE_SHAPES,
  BARCODE_SHAPE_CREDIT,
  renderBarcodeSvg,
  scanCodeFor,
} from '@ebda/shared';
import { apiPut } from '../lib/api';
import { checkSvgBarcode } from '../lib/label-export';
import { useT } from '@/i18n/useT';
import { BarcodeStyleGrid, BarcodeStyleTile } from './BarcodeStyleTile';

const SAMPLE = 'ORD-48213';

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
  selfCheck = false,
}: {
  storeId: string;
  value: string | undefined;
  onSaved: (shape: string) => void;
  /** Read the chosen shape back with the in-house reader (needs a browser canvas) and block Save when it will not scan. */
  selfCheck?: boolean;
}) {
  const t = useT('receiptBarcode');
  const [choice, setChoice] = useState(value ?? 'plain');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const options = ['plain', 'off', ...RECEIPT_BARCODE_SHAPES];
  const [scan, setScan] = useState<'checking' | 'ok' | 'fail' | 'na'>(
    selfCheck ? 'checking' : 'na'
  );
  useEffect(() => {
    if (!selfCheck) return;
    if (choice === 'off') {
      setScan('na');
      return;
    }
    let alive = true;
    setScan('checking');
    checkSvgBarcode(
      renderBarcodeSvg({ value: SAMPLE, shape: choice, label: false, ink: '#000000' }),
      scanCodeFor(SAMPLE)
    )
      .then(ok => alive && setScan(ok ? 'ok' : 'fail'))
      .catch(() => alive && setScan('fail'));
    return () => {
      alive = false;
    };
  }, [selfCheck, choice]);

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
      <BarcodeStyleGrid label={t('title')}>
        {options.map(id => (
          <BarcodeStyleTile
            key={id}
            id={id}
            name={t(`shape.${id}`)}
            sample={SAMPLE}
            selected={choice === id}
            onSelect={() => setChoice(id)}
          />
        ))}
      </BarcodeStyleGrid>
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          type="button"
          onClick={save}
          disabled={
            saving || choice === (value ?? 'plain') || scan === 'checking' || scan === 'fail'
          }
          className="font-semibold"
        >
          {t('saveShape')}
        </Button>
        {scan !== 'na' && (
          <span
            role="status"
            aria-live="polite"
            className={`text-xs ${scan === 'ok' ? 'text-success-ink' : scan === 'fail' ? 'text-destructive-ink' : 'text-muted-foreground'}`}
          >
            {t(`scan.${scan}`)}
          </span>
        )}
        {msg && (
          <span
            role="status"
            className={`text-xs ${msg.ok ? 'text-success-ink' : 'text-destructive-ink'}`}
          >
            {msg.text}
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{BARCODE_SHAPE_CREDIT}</p>
    </section>
  );
}
