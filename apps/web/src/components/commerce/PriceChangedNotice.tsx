'use client';
import { useEffect, useRef } from 'react';
import { useLanguage } from '@/contexts/LanguageContext';
import { useLocalePrice } from '@/hooks/useLocalePrice';
import type { PriceChangedLine } from '@/lib/gold-display';

/**
 * "السعر اتحدّث" (Ruling B5-17): shown on the cart and at checkout when a gold line's price moved since the
 * shopper added it. The new price is already on the line; the button records that they have seen it, and the
 * checkout then proceeds at the current price. Nothing is charged until they continue.
 *
 * A polite status (not an alert: it is not an error), focus moves to it when it appears, and each moved line
 * reads old (struck) then new. Token colours only, a 44px primary button.
 */
export function PriceChangedNotice({
  onContinue,
  busy = false,
  lines = [],
  className,
}: {
  onContinue: () => void;
  busy?: boolean;
  lines?: PriceChangedLine[];
  className?: string;
}) {
  const { t, language } = useLanguage();
  const money = useLocalePrice();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: false });
  }, []);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="status"
      aria-live="polite"
      data-testid="price-changed-notice"
      className={`rounded-lg border border-border border-s-4 border-s-accent bg-muted p-4 text-sm text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${className ?? ''}`}
    >
      <p className="font-semibold">{t('Price updated', 'السعر اتحدّث')}</p>
      <p className="mt-1 text-muted-foreground">
        {t(
          'The gold rate changed since you added this piece. The new price is shown.',
          'سعر الدهب اتغيّر من ساعة ما ضفت القطعة للسلة، والسعر الجديد ظاهر قدامك.'
        )}
      </p>
      {lines.length > 0 && (
        <ul className="mt-3 space-y-1" data-testid="price-changed-lines">
          {lines.map(l => (
            <li key={l.id} className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{l.name}</span>
              {l.previous !== undefined && l.previous !== l.current && (
                <span
                  className="text-muted-foreground line-through"
                  aria-label={t('Old price', 'السعر القديم')}
                  data-language={language}
                >
                  {money(l.previous)}
                </span>
              )}
              <span aria-label={t('New price', 'السعر الجديد')}>{money(l.current)}</span>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={onContinue}
        className="mt-3 inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground disabled:opacity-60"
      >
        {t('Continue', 'متابعة')}
      </button>
    </div>
  );
}
