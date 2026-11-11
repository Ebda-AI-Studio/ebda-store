'use client';

import { Button } from '@/components/ui/Button';
import { useMemo } from 'react';
import {
  BRAND,
  BARCODE_DISPLAY_PX,
  EBDA_BILLING_BARCODE_SHAPE,
  billingPaymentNumber,
  formatMoney,
  renderBarcodeSvg,
} from '@ebda/shared';
import { ReceiptPrinterShell } from '@ebda/ui';
import { useT } from '../../i18n/useT';
import { fmtDate, type UiLocale } from './format';

export interface BillingReceiptCharge {
  id: string;
  planCode: string | null;
  amountMinor: number;
  createdAt: string;
  vatMinor?: number;
  vat?: { rateBps: number; trn?: string | null } | null;
}

/** Ebda palette (BRAND): night body, gold accent. Never the storefront orange. */
const PALETTE = {
  '--rp-housing': '#15171A',
  '--rp-screen-bg': BRAND.colors.night,
  '--rp-screen-fg': '#F4EFE6',
  '--rp-slit': '#000',
} as React.CSSProperties;

/** Print only the receipt paper: hide the page around it and the printer body. */
const PRINT_CSS = `@media print{body *{visibility:hidden}.ebda-receipt-print,.ebda-receipt-print *{visibility:visible}.ebda-receipt-print{position:absolute;inset-inline:0;top:0;margin:0 auto}.ebda-receipt-print .rp-housing,.ebda-receipt-print .ebda-no-print{display:none}}`;

/**
 * Ebda's own billing receipt after a merchant pays: the storefront's receipt
 * printer (shared `ReceiptPrinterShell`, same feed, same reduced-motion rule)
 * in the Ebda palette, printing a palm-shaped Code 128 of the payment number.
 * Printable (the paper prints alone).
 */
export function EbdaBillingReceipt({
  charge,
  planName,
  locale,
}: {
  charge: BillingReceiptCharge;
  planName?: string;
  locale: UiLocale;
}) {
  const t = useT('ebdaReceipt');
  const number = useMemo(() => billingPaymentNumber(charge.id), [charge.id]);
  const svg = useMemo(
    () =>
      renderBarcodeSvg({
        value: number,
        shape: EBDA_BILLING_BARCODE_SHAPE,
        label: false,
        displayPx: BARCODE_DISPLAY_PX.billingReceipt,
      }),
    [number]
  );
  const money = (n: number) => formatMoney(n, locale, { fixedDecimals: true });
  const wordmark = locale === 'ar' ? BRAND.nameAr : BRAND.name;

  return (
    <div className="ebda-receipt-print">
      <style>{PRINT_CSS}</style>
      <ReceiptPrinterShell
        feedKey={charge.id}
        storagePrefix="ebda-billing-receipt:"
        paperTestId="ebda-receipt-paper"
        ariaLabel={t('aria')}
        style={PALETTE}
        paperClassName="px-5 pt-6 text-sm leading-snug"
        screen={({ feedDone }) => (
          <div>
            <div className="flex items-start justify-between gap-4">
              <p className="text-sm font-semibold" style={{ color: BRAND.colors.lift }}>
                {wordmark}
              </p>
              <div className="shrink-0 text-end">
                <p className="text-xs opacity-60">{t('total')}</p>
                <p className="text-base font-semibold tabular-nums">{money(charge.amountMinor)}</p>
              </div>
            </div>
            <p className="mt-3 min-h-5 text-xs" role="status" aria-live="polite">
              {feedDone ? t('paid') : t('printing')}
            </p>
          </div>
        )}
      >
        <h2 className="text-center text-base font-semibold" style={{ color: BRAND.colors.night }}>
          {wordmark}
        </h2>
        <p className="mt-0.5 text-center text-xs opacity-60">{t('subtitle')}</p>
        <hr className="my-4 border-0 border-t border-dashed border-black/30" />
        <dl className="space-y-1.5 text-xs">
          {(planName || charge.planCode) && (
            <Row label={t('plan')}>{planName ?? charge.planCode}</Row>
          )}
          <Row label={t('date')}>{fmtDate(charge.createdAt, locale)}</Row>
          {charge.vat && (charge.vatMinor ?? 0) > 0 && (
            <Row label={t('vat', { rate: charge.vat.rateBps / 100 })}>
              {money(charge.vatMinor ?? 0)}
            </Row>
          )}
          <Row label={t('total')}>
            <strong>{money(charge.amountMinor)}</strong>
          </Row>
        </dl>
        <hr className="my-4 border-0 border-t border-dashed border-black/30" />
        <div className="flex flex-col items-center gap-1.5 pb-4">
          <bdi dir="ltr" className="block w-full">
            <span
              aria-hidden="true"
              data-testid="ebda-receipt-barcode"
              className="block [&>svg]:h-auto [&>svg]:w-full"
              // Our own encoder's output; the payment number is hex-derived.
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </bdi>
          <p
            data-testid="ebda-receipt-number"
            dir="ltr"
            className="font-mono text-xs tracking-[0.3em] opacity-60"
          >
            {number}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          type="button"
          onClick={() => window.print()}
          className="mb-4 w-full font-semibold ebda-no-print"
        >
          {t('print')}
        </Button>
      </ReceiptPrinterShell>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="opacity-60">{label}</dt>
      <dd className="text-end">{children}</dd>
    </div>
  );
}
