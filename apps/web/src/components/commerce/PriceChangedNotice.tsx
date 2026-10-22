'use client';
import { useLanguage } from '@/contexts/LanguageContext';

/**
 * "السعر اتحدّث" (Ruling B5-17): shown on the cart and at checkout when a gold line's price moved since the
 * shopper added it. The new price is already on the line; the button records that they have seen it, and the
 * checkout then proceeds at the current price. Nothing is charged until they continue.
 */
export function PriceChangedNotice({
  onContinue,
  busy = false,
  className,
}: {
  onContinue: () => void;
  busy?: boolean;
  className?: string;
}) {
  const { t } = useLanguage();
  return (
    <div
      role="alert"
      data-testid="price-changed-notice"
      className={`rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm ${className ?? ''}`}
    >
      <p className="font-semibold text-foreground">
        {t('The price has been updated', 'السعر اتحدّث')}
      </p>
      <p className="mt-1 text-muted-foreground">
        {t(
          'The gold rate changed since you added this piece. The new price is shown.',
          'سعر الدهب اتغيّر من ساعة ما ضفت القطعة، والسعر الجديد ظاهر قدامك.'
        )}
      </p>
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
