'use client';

import { minorToDecimalString } from '@ebda/shared';
import { useT } from '@/i18n/useT';
import type { RefundQuote, Selection } from './useOrderRefundQuote';

interface Props {
  idPrefix: string;
  quote: RefundQuote;
  currency: string;
  value: Selection;
  onChange: (next: Selection) => void;
  disabled?: boolean;
}

/**
 * The line table of the partial-refund and new-return dialogs: tick a line, set how many units, and (for a stock-tracked
 * product) whether the goods go back on the shelf. Everything the server enforces is shown, not hidden: a line with nothing
 * left to return is disabled and says why. When the ticked lines cover the whole order the whole-order path applies, which
 * restocks every line, so the per-line restock choice is locked on and says so.
 */
export function RefundLinesPicker({ idPrefix, quote, currency, value, onChange, disabled }: Props) {
  const t = useT('refundLines');
  const set = (id: string, patch: Partial<Selection[string]>) =>
    onChange({ ...value, [id]: { ...value[id], ...patch } });

  return (
    <fieldset className="min-w-0" disabled={disabled}>
      <legend className="mb-2 text-sm font-medium text-foreground">{t('legend')}</legend>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {quote.lines.map(l => {
          const c = value[l.orderItemId];
          const none = l.remaining <= 0;
          const checkId = `${idPrefix}-check-${l.orderItemId}`;
          const qtyId = `${idPrefix}-qty-${l.orderItemId}`;
          const restockId = `${idPrefix}-restock-${l.orderItemId}`;
          return (
            <li key={l.orderItemId} className="flex flex-col gap-2 p-3">
              <div className="flex items-start gap-3">
                <input
                  id={checkId}
                  type="checkbox"
                  className="mt-1 h-5 w-5 shrink-0 cursor-pointer accent-primary"
                  checked={!!c?.checked && !none}
                  disabled={none}
                  onChange={e => set(l.orderItemId, { checked: e.target.checked })}
                />
                <label htmlFor={checkId} className="min-w-0 flex-1 cursor-pointer text-sm">
                  <span className="block font-medium text-foreground">{l.name}</span>
                  <span className="block text-muted-foreground">
                    {t('unitPrice', { price: minorToDecimalString(l.unitPrice), currency })}
                    {' · '}
                    {none
                      ? t('nothingLeft')
                      : t('remaining', { remaining: l.remaining, ordered: l.quantity })}
                  </span>
                </label>
              </div>
              {c?.checked && !none && (
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2 ps-8">
                  <label htmlFor={qtyId} className="flex items-center gap-2 text-sm">
                    <span className="text-foreground">{t('quantity')}</span>
                    <input
                      id={qtyId}
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={l.remaining}
                      step={1}
                      value={c.quantity}
                      onChange={e =>
                        set(l.orderItemId, {
                          quantity: Math.max(
                            1,
                            Math.min(l.remaining, Math.floor(Number(e.target.value)) || 1)
                          ),
                        })
                      }
                      className="h-11 w-20 rounded-lg border border-border bg-background px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </label>
                  {l.trackInventory ? (
                    <label htmlFor={restockId} className="flex min-h-11 items-center gap-2 text-sm">
                      <input
                        id={restockId}
                        type="checkbox"
                        className="h-5 w-5 cursor-pointer accent-primary"
                        checked={quote.coversWholeOrder ? true : c.restock}
                        disabled={quote.coversWholeOrder}
                        onChange={e => set(l.orderItemId, { restock: e.target.checked })}
                      />
                      <span className="text-foreground">{t('restock')}</span>
                    </label>
                  ) : (
                    <span className="text-sm text-muted-foreground">{t('notTracked')}</span>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {quote.coversWholeOrder && (
        <p role="note" className="mt-2 text-xs text-muted-foreground">
          {t('wholeOrderRestockNote')}
        </p>
      )}
    </fieldset>
  );
}
