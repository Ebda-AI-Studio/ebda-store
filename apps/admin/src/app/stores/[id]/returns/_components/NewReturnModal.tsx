'use client';

import { FIELD_CLASSES, TEXTAREA_CLASSES } from '@/components/ui/tokens';
import { useEffect, useState } from 'react';
import { Modal, useToast } from '@ebda/ui';
import { minorToDecimalString, moveSearchToHeader } from '@ebda/shared';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { apiGet, apiRequest } from '../../../../../lib/api';
import { RefundLinesPicker } from '../../../../../components/refund/RefundLinesPicker';
import {
  emptySelection,
  selectionItems,
  useOrderRefundQuote,
  type Selection,
} from '../../../../../components/refund/useOrderRefundQuote';

interface FoundOrder {
  id: string;
  orderNumber?: string;
  status: string;
}

interface Props {
  open: boolean;
  storeId: string;
  onClose: () => void;
  /** Called after the return was opened, so the list refetches. */
  onCreated: () => void;
}

const KNOWN_ERRORS = new Set([
  'INVALID_QUANTITY',
  'INVALID_ORDER',
  'INVALID_ITEM',
  'GUEST_ORDER_RETURN_UNSUPPORTED',
  'NO_ITEMS',
  'bundle_returns_are_atomic',
  'FORBIDDEN',
]);

/**
 * "New return" (STORE-QA-76): the merchant opens a return for a customer's order (a phone or WhatsApp request). Find the order
 * by its number, tick the lines and quantities, say whether each goes back on the shelf, give a reason. The return opens
 * PENDING; approve, receive and the refund (with its method) are the same steps the table already has.
 */
export function NewReturnModal({ open, storeId, onClose, onCreated }: Props) {
  const t = useT('returns.newReturn');
  const tCommon = useT('common');
  const toast = useToast();
  const [term, setTerm] = useState('');
  const [searching, setSearching] = useState(false);
  const [found, setFound] = useState<FoundOrder[] | null>(null);
  const [order, setOrder] = useState<FoundOrder | null>(null);
  const [sel, setSel] = useState<Selection | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [attemptKey, setAttemptKey] = useState(() => crypto.randomUUID());

  const { quote, loading, errorCode } = useOrderRefundQuote(storeId, order?.id ?? null, sel);
  useEffect(() => {
    if (quote && !sel) setSel(emptySelection(quote));
  }, [quote, sel]);

  useEffect(() => {
    if (!open) return;
    setTerm('');
    setFound(null);
    setOrder(null);
    setSel(null);
    setReason('');
    setFailure(null);
    setAttemptKey(crypto.randomUUID());
  }, [open]);

  const search = async () => {
    const n = term.trim();
    if (!n) return;
    setSearching(true);
    setFound(null);
    try {
      const { params, headers } = moveSearchToHeader(
        new URLSearchParams({ search: n, limit: '8', page: '1' })
      );
      const { data } = await apiGet<{ orders: FoundOrder[] }>(
        `/api/v1/stores/${storeId}/orders?${params}`,
        headers
      );
      setFound((data?.orders ?? []).filter(o => o.status === 'delivered'));
    } finally {
      setSearching(false);
    }
  };

  const items = quote && sel ? selectionItems(quote, sel) : [];
  const canSubmit =
    !!quote && quote.returnable.ok && items.length > 0 && reason.trim().length > 0 && !busy;

  const submit = async () => {
    if (!order || !canSubmit) return;
    setBusy(true);
    setFailure(null);
    try {
      const { data, error } = await apiRequest<{ return: { returnNumber: string } }>(
        `/api/v1/stores/${storeId}/returns/admin`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': attemptKey },
          body: JSON.stringify({
            orderId: order.id,
            type: 'return',
            reason: reason.trim(),
            items,
          }),
        }
      );
      if (error || !data) {
        setFailure(error && KNOWN_ERRORS.has(error.code) ? error.code : 'UNKNOWN');
        return;
      }
      toast.success(
        t('toastSuccessTitle'),
        t('toastSuccessBody', { number: data.return.returnNumber })
      );
      onCreated();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={open} onClose={busy ? () => undefined : onClose} title={t('title')} size="md">
      <div className="space-y-4">
        {!order ? (
          <>
            <form
              className="flex items-end gap-2"
              onSubmit={e => {
                e.preventDefault();
                void search();
              }}
            >
              <div className="min-w-0 flex-1">
                <label
                  htmlFor="new-return-order"
                  className="mb-1 block text-sm font-medium text-foreground"
                >
                  {t('orderLabel')}
                </label>
                <input
                  id="new-return-order"
                  value={term}
                  onChange={e => setTerm(e.target.value)}
                  placeholder={t('orderPlaceholder')}
                  className={FIELD_CLASSES}
                  autoFocus
                />
              </div>
              <Button
                type="submit"
                variant="outline"
                disabled={searching || !term.trim()}
                isLoading={searching}
              >
                {t('search')}
              </Button>
            </form>
            {found && found.length === 0 && (
              <p role="status" className="text-sm text-muted-foreground">
                {t('noDeliveredOrder')}
              </p>
            )}
            {found && found.length > 0 && (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {found.map(o => (
                  <li key={o.id}>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setOrder(o)}
                      className="w-full justify-between"
                    >
                      <span className="font-medium">{o.orderNumber ?? o.id}</span>
                      <span className="text-muted-foreground">{t('pick')}</span>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : loading && !quote ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('loading')}
          </p>
        ) : !quote ? (
          <p role="alert" className="text-sm text-destructive-ink">
            {t('loadFailed')}
            {errorCode ? ` (${errorCode})` : ''}
          </p>
        ) : !quote.returnable.ok ? (
          <p role="alert" className="text-sm text-destructive-ink">
            {t(`blocked.${quote.returnable.reason}`)}
          </p>
        ) : (
          <>
            <p className="text-sm text-foreground">
              {t('forOrder', { number: quote.orderNumber })}
            </p>
            {sel && (
              <RefundLinesPicker
                idPrefix="new-return"
                quote={quote}
                currency={quote.currency}
                value={sel}
                onChange={setSel}
                disabled={busy}
              />
            )}
            <p
              aria-live="polite"
              className="rounded-lg border border-border p-3 text-sm text-foreground"
              data-testid="new-return-estimate"
            >
              {items.length === 0
                ? t('pickLines')
                : loading || quote.estimate === null
                  ? t('estimating')
                  : t('estimate', {
                      amount: minorToDecimalString(quote.estimate),
                      currency: quote.currency,
                    })}
            </p>
            <div>
              <label
                htmlFor="new-return-reason"
                className="mb-1 block text-sm font-medium text-foreground"
              >
                {t('reasonLabel')}
              </label>
              <textarea
                id="new-return-reason"
                value={reason}
                onChange={e => setReason(e.target.value)}
                disabled={busy}
                rows={2}
                maxLength={500}
                placeholder={t('reasonPlaceholder')}
                className={TEXTAREA_CLASSES}
              />
            </div>
          </>
        )}

        {failure && (
          <p role="alert" className="text-sm text-destructive-ink">
            {t(`errors.${failure}`)}
          </p>
        )}

        <div className="flex justify-end gap-3">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {tCommon('cancel')}
          </Button>
          {order && (
            <Button onClick={submit} disabled={!canSubmit} isLoading={busy}>
              {busy ? t('creating') : t('create')}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
