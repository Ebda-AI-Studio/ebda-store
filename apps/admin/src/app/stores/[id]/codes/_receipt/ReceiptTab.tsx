'use client';

import { useEffect, useState } from 'react';
import { useT } from '@/i18n/useT';
import { apiGet } from '../../../../../lib/api';
import { ReceiptBarcodePicker } from '../../../../../components/ReceiptBarcodePicker';

/** The order barcode on receipts, packing slips and invoices (moved here from the delivery page). */
export function ReceiptTab({ storeId }: { storeId: string }) {
  const t = useT('codes.receipt');
  const [state, setState] = useState<{ loaded: boolean; shape: string | undefined }>({
    loaded: false,
    shape: undefined,
  });

  useEffect(() => {
    let alive = true;
    apiGet<{ store: { settings?: { receiptBarcodeShape?: string } } }>(
      `/api/v1/stores/${storeId}`
    ).then(
      ({ data }) =>
        alive && setState({ loaded: true, shape: data?.store?.settings?.receiptBarcodeShape })
    );
    return () => {
      alive = false;
    };
  }, [storeId]);

  if (!state.loaded)
    return (
      <div className="flex h-40 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
      </div>
    );
  return (
    <div className="max-w-3xl space-y-4">
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      <ReceiptBarcodePicker
        storeId={storeId}
        value={state.shape}
        onSaved={shape => setState({ loaded: true, shape })}
        selfCheck
      />
    </div>
  );
}
