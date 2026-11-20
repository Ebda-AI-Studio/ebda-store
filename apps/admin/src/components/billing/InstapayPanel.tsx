'use client';

import { useState } from 'react';
import { formatMoney } from '@ebda/shared';
import { useT } from '../../i18n/useT';
import { CopyRow } from './CopyRow';
import type { UiLocale } from './format';
import type { BillingInfo } from './types';

/**
 * What the merchant needs to pay Ebda by InstaPay: the QR (when configured),
 * the handle, the exact amount (with Ebda's VAT line when it applies) and their
 * reference, each with a copy button. On phones, where the QR cannot be scanned
 * from the same screen, it leads with "open the InstaPay app" steps. Shared by
 * the onboarding billing step and the billing page so they cannot drift.
 */
export function InstapayPanel({
  instapay,
  locale,
}: {
  instapay: BillingInfo['instapay'];
  locale: UiLocale;
}) {
  const t = useT('billing.instapay');
  const [qrFailed, setQrFailed] = useState(false);
  const amount =
    instapay.amountMinor !== null
      ? formatMoney(instapay.amountMinor, locale, { fixedDecimals: true })
      : null;
  const vat = instapay.vat && instapay.vat.vatMinor > 0 ? instapay.vat : null;
  const showQr = !!instapay.qrUrl && !qrFailed;
  const rows = [
    [t('handle'), instapay.handle],
    [t('mobile'), instapay.mobile ?? null],
    [t('amount'), amount],
    [t('reference'), instapay.reference],
  ] as const;

  if (instapay.notDue) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="instapay-not-due">
        {t('notDue')}
      </p>
    );
  }

  return (
    <div className="space-y-3 text-sm">
      <ol
        aria-label={t('phoneTitle')}
        className="list-decimal space-y-1 rounded-lg bg-muted/50 p-3 ps-8 text-muted-foreground md:hidden"
      >
        <li>{t('phoneStep1')}</li>
        <li>{t('phoneStep2')}</li>
        <li>{t('phoneStep3')}</li>
      </ol>
      <div className="flex flex-col gap-4 md:flex-row md:items-start">
        {showQr && (
          <figure className="mx-auto shrink-0 md:mx-0">
            {/* eslint-disable-next-line @next/next/no-img-element -- static QR on the media host; next/image adds nothing here */}
            <img
              src={instapay.qrUrl!}
              alt={t('qrAlt')}
              width={176}
              height={176}
              loading="lazy"
              onError={() => setQrFailed(true)}
              className="h-44 w-44 rounded-lg border border-border bg-white object-contain p-1"
            />
            <figcaption className="mt-1 max-w-44 text-center text-xs text-muted-foreground">
              {t('qrHint')}
            </figcaption>
          </figure>
        )}
        <div className="min-w-0 flex-1 space-y-3">
          {rows.map(([label, value]) =>
            value ? (
              <CopyRow
                key={label}
                label={label}
                value={value}
                copyLabel={t('copy')}
                copiedLabel={t('copied')}
              />
            ) : null
          )}
          {vat && (
            <p className="text-xs text-muted-foreground" data-testid="instapay-vat">
              {t('vatLine', {
                rate: vat.rateBps / 100,
                vat: formatMoney(vat.vatMinor, locale, { fixedDecimals: true }),
                net: formatMoney(vat.netMinor, locale, { fixedDecimals: true }),
              })}
              {vat.legalName || vat.trn
                ? ` ${t('seller', { name: vat.legalName ?? '', trn: vat.trn ?? '' })}`
                : ''}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
