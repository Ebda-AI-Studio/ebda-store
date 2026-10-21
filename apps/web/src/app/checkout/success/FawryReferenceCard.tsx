'use client';

import { useState } from 'react';
import { useLanguage } from '../../../contexts/LanguageContext';

/**
 * The Fawry reference code (SP6b): the customer pays it in cash at any Fawry outlet (or with
 * a Fawry wallet / ATM). The order stays unpaid until Fawry's notification (or the verify-on-
 * return poll) says it is paid. Only the code is shown, in a copyable box; the amount is on
 * the order summary below.
 */
export function FawryReferenceCard({ code }: { code: string }) {
  const { t } = useLanguage();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked: the code is selectable text, the customer can copy it by hand.
    }
  };

  return (
    <section
      className="mt-6 rounded-xl border border-warning/30 bg-warning/10 p-5 text-start"
      data-testid="fawry-reference-card"
      aria-label={t('Fawry payment code', 'كود الدفع في فوري')}
    >
      <h2 className="text-base font-semibold text-foreground">
        {t('Pay at a Fawry outlet', 'ادفع في أي منفذ فوري')}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t(
          'Tell the cashier this code, or enter it in the Fawry app. Your order is confirmed as soon as Fawry receives the payment.',
          'ادّي الكاشير الكود ده أو اكتبه في تطبيق فوري. طلبك هيتأكد أول ما فوري يستلم المبلغ.'
        )}
      </p>
      <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border bg-background px-4 py-3">
        <span
          className="select-all font-mono text-xl font-bold tracking-widest text-foreground"
          dir="ltr"
          data-testid="fawry-reference-code"
        >
          {code}
        </span>
        <button
          type="button"
          onClick={copy}
          className="rounded-md border border-input px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted"
        >
          {copied ? t('Copied', 'اتنسخ') : t('Copy', 'نسخ')}
        </button>
      </div>
    </section>
  );
}
