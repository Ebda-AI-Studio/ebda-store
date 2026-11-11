'use client';

import { useState } from 'react';
import { useLocale } from 'next-intl';
import { Badge, Input } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { formatMoney, type InstapayReceiptView } from '@ebda/shared';
import { useT } from '../../i18n/useT';
import { useBlobUrl } from './api';
import { cairoParts } from './format';

type Row = { key: string; submitted: string | null; read: string | null; dir?: 'ltr' };

/**
 * What an approver sees for one InstaPay receipt: the screenshot (streamed with
 * the session, never a public URL), the fields the payer submitted next to what
 * the AI read, the checks that fired (warnings, never blocks) and the decision.
 * The caller decides the endpoints and which decisions exist: pass `onApprove`
 * and/or `onReject` only for the people who may take them.
 */
export function InstapayReceiptReview({
  receipt,
  imageEndpoint,
  onApprove,
  onReject,
  approveLabel,
  busy = false,
}: {
  receipt: InstapayReceiptView;
  /** Endpoint of the screenshot bytes (fetched as a blob with credentials). */
  imageEndpoint: string;
  onApprove?: () => void;
  /** Resolves to an error text to show under the reason box, or null on success. */
  onReject?: (note: string) => Promise<string | null>;
  approveLabel?: string;
  busy?: boolean;
}) {
  const t = useT('instapayReceipt.review');
  const tFlags = useT('instapayReceipt.flags');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const image = useBlobUrl(imageEndpoint);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState('');
  const [working, setWorking] = useState(false);

  const money = (minor: number | null) =>
    minor === null ? null : formatMoney(minor, locale, { fixedDecimals: true });
  const x = receipt.extracted;
  const f = receipt.fields;
  const at = cairoParts(f.transferredAt);
  const readAt = x?.transferDate && x.transferTime ? `${x.transferDate} ${x.transferTime}` : null;

  const rows = (
    [
      { key: 'amount', submitted: money(f.amountMinor), read: money(x?.amountMinor ?? null) },
      { key: 'reference', submitted: f.reference, read: x?.reference ?? null, dir: 'ltr' },
      {
        key: 'transferredAt',
        submitted: at ? `${at.date} ${at.time}` : null,
        read: readAt,
        dir: 'ltr',
      },
      { key: 'payerName', submitted: f.payerName, read: x?.payerName ?? null },
      { key: 'payerAddress', submitted: f.payerAddress, read: x?.payerAddress ?? null, dir: 'ltr' },
      { key: 'payerMobile', submitted: f.payerMobile, read: x?.payerMobile ?? null, dir: 'ltr' },
      { key: 'payerBank', submitted: f.payerBank, read: x?.payerBank ?? null },
      { key: 'receiverName', submitted: f.receiverName, read: x?.receiverName ?? null },
      {
        key: 'receiverHandle',
        submitted: f.receiverHandle,
        read: x?.receiverHandle ?? null,
        dir: 'ltr',
      },
      {
        key: 'receiverMobile',
        submitted: f.receiverMobile,
        read: x?.receiverMobile ?? null,
        dir: 'ltr',
      },
      { key: 'note', submitted: f.note, read: x?.note ?? null },
    ] satisfies Row[]
  ).filter(r => r.submitted || r.read);

  const confidence = receipt.confidence ?? x?.confidence ?? null;
  const decidable = receipt.status === 'submitted';
  const amountMismatch = receipt.flags.includes('AMOUNT_MISMATCH');

  async function reject() {
    if (!onReject) return;
    if (note.trim().length < 3) {
      setNoteError(t('reasonRequired'));
      return;
    }
    setWorking(true);
    const err = await onReject(note.trim());
    setWorking(false);
    if (err) {
      setNoteError(err);
      return;
    }
    setRejecting(false);
    setNote('');
    setNoteError('');
  }

  return (
    <div className="space-y-3 text-sm" data-testid="instapay-receipt-review">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge
          variant={
            receipt.status === 'approved'
              ? 'success'
              : receipt.status === 'rejected' || receipt.status === 'voided'
                ? 'destructive'
                : 'warning'
          }
        >
          {t(`status.${receipt.status}`)}
        </Badge>
        {confidence !== null && (
          <span className="text-xs text-muted-foreground">
            {t('confidence', { pct: Math.round(confidence * 100) })}
          </span>
        )}
      </div>

      {receipt.flags.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={t('flagsTitle')}>
          {receipt.flags.map(flag => (
            <li key={flag}>
              <Badge
                variant="warning"
                className={flag === 'AMOUNT_MISMATCH' ? 'ring-2 ring-warning' : ''}
              >
                {tFlags(flag)}
              </Badge>
            </li>
          ))}
        </ul>
      )}
      {/* SEC-11: an empty flag list is never a positive signal. */}
      <p role="note" className="text-xs text-muted-foreground" data-testid="instapay-ai-advisory">
        {t('aiAdvisory')}
      </p>
      {amountMismatch && receipt.expectedAmountMinor !== null && (
        <p role="alert" className="text-sm font-semibold text-destructive-ink">
          {t('amountMismatch', {
            paid: money(f.amountMinor) ?? '—',
            expected: money(receipt.expectedAmountMinor) ?? '—',
          })}
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-[minmax(0,14rem)_1fr]">
        <div>
          {image.loading && <p className="text-xs text-muted-foreground">{t('imageLoading')}</p>}
          {image.failed && (
            <p role="alert" className="text-xs text-destructive-ink">
              {t('imageFailed')}
            </p>
          )}
          {image.url && (
            <a href={image.url} target="_blank" rel="noreferrer noopener" title={t('openImage')}>
              <img
                src={image.url}
                alt={t('imageAlt')}
                className="max-h-80 w-full rounded-lg border object-contain"
              />
            </a>
          )}
        </div>
        <div className="min-w-0 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-start text-muted-foreground">
                <th className="py-1 pe-2 text-start font-medium">{t('field')}</th>
                <th className="py-1 pe-2 text-start font-medium">{t('submitted')}</th>
                <th className="py-1 text-start font-medium">{t('readByAi')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const differs = !!r.read && !!r.submitted && r.read !== r.submitted;
                return (
                  <tr key={r.key} className="border-b last:border-0 align-top">
                    <td className="py-1 pe-2 text-muted-foreground">{t(`fields.${r.key}`)}</td>
                    <td className="py-1 pe-2 font-medium" dir={r.dir}>
                      {r.submitted ?? '—'}
                    </td>
                    <td
                      className={`py-1 ${differs ? 'font-semibold text-warning-ink' : 'text-muted-foreground'}`}
                      dir={r.dir}
                    >
                      {r.read ?? '—'}
                    </td>
                  </tr>
                );
              })}
              {receipt.expectedAmountMinor !== null && (
                <tr className="border-t">
                  <td className="py-1 pe-2 text-muted-foreground">{t('expectedAmount')}</td>
                  <td className="py-1 pe-2 font-medium" colSpan={2}>
                    {money(receipt.expectedAmountMinor)}
                  </td>
                </tr>
              )}
              {receipt.expectedReceiver && (
                <tr>
                  <td className="py-1 pe-2 text-muted-foreground">{t('expectedReceiver')}</td>
                  <td className="py-1 pe-2 font-medium" colSpan={2} dir="ltr">
                    {receipt.expectedReceiver}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {receipt.reviewNote && receipt.status !== 'submitted' && (
        <p className="text-sm">
          <span className="font-medium">{t('reviewNote')}</span> {receipt.reviewNote}
        </p>
      )}

      {decidable && (onApprove || onReject) && !rejecting && (
        <div className="flex flex-wrap gap-2">
          {onApprove && (
            <Button className="max-md:min-h-11" disabled={busy} onClick={onApprove}>
              {approveLabel ?? t('approve')}
            </Button>
          )}
          {onReject && (
            <Button
              variant="outline"
              className="max-md:min-h-11"
              disabled={busy}
              onClick={() => setRejecting(true)}
            >
              {t('reject')}
            </Button>
          )}
        </div>
      )}

      {decidable && onReject && rejecting && (
        <form
          noValidate
          className="space-y-2"
          onSubmit={e => {
            e.preventDefault();
            void reject();
          }}
        >
          <Input
            id={`reject-${receipt.id}`}
            label={t('reasonLabel')}
            value={note}
            onChange={e => setNote(e.target.value)}
            error={noteError || undefined}
          />
          <p className="text-xs text-muted-foreground">{t('reasonHelp')}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="destructive" disabled={working || busy}>
              {t('rejectSubmit')}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setRejecting(false);
                setNoteError('');
              }}
            >
              {t('cancel')}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
