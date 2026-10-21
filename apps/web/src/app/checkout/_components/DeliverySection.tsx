'use client';

import { useLanguage } from '../../../contexts/LanguageContext';
import { formatWindowTime, type DeliverySelection } from '../_lib/deliveryWindows';
import type { CheckoutDeliverySettings } from '@ebda/shared';

interface DeliverySectionProps {
  settings: CheckoutDeliverySettings;
  /** Resolved today/tomorrow day + per-window availability (see resolveDeliverySelection). */
  selection: DeliverySelection;
  selectedWindowId: string | null;
  onSelectWindow: (id: string) => void;
  /** Validation message when windows are enabled + available but none picked. */
  error?: string | null;
}

/**
 * Per-store, opt-in checkout "delivery" block — merchant note + delivery
 * time-window picker. Rendered immediately above the Pay button (see
 * PaymentStep's `deliverySection` prop). Both parts are independently
 * toggleable via `settings.note.enabled` / `settings.windows.enabled`, and
 * this component renders nothing when both are off (caller should also
 * skip rendering it in that case, but this guard makes it safe either way).
 */
export function DeliverySection({
  settings,
  selection,
  selectedWindowId,
  onSelectWindow,
  error,
}: DeliverySectionProps) {
  const { language, t } = useLanguage();

  const showNote = settings.note?.enabled && (settings.note.text || settings.note.textAr);
  const showWindows = settings.windows?.enabled;
  const { day, windows } = selection;
  const anyAvailable = windows.some(w => w.available);

  if (!showNote && !showWindows) return null;

  return (
    <div className="rounded-[var(--radius)] border bg-card p-4 shadow-sm space-y-3">
      {showNote && (
        <div className="rounded-lg bg-muted/50 p-3 text-sm text-foreground">
          {language === 'ar' ? settings.note.textAr || settings.note.text : settings.note.text}
        </div>
      )}

      {showWindows && (
        <div className={showNote ? 'pt-1' : undefined}>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium text-foreground">
              {t('Delivery window', 'موعد التوصيل')}
            </h3>
            {windows.length > 0 && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                {day === 'tomorrow' ? t('Tomorrow', 'غدًا') : t('Today', 'اليوم')}
              </span>
            )}
          </div>

          {anyAvailable ? (
            <div
              className="mt-2 flex flex-wrap gap-2"
              role="radiogroup"
              aria-label={t('Delivery window', 'موعد التوصيل')}
            >
              {windows.map(w => {
                const selected = selectedWindowId === w.id;
                return (
                  <button
                    key={w.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={!w.available}
                    onClick={() => onSelectWindow(w.id)}
                    className={`rounded-lg border px-3 py-2 text-sm transition ${
                      selected
                        ? 'border-primary bg-primary/5 text-foreground'
                        : w.available
                          ? 'border-input text-foreground hover:border-input/80'
                          : 'cursor-not-allowed border-input/50 text-muted-foreground opacity-50'
                    }`}
                  >
                    <span className="font-medium">{language === 'ar' ? w.labelAr : w.label}</span>
                    <span className="ms-1.5 text-xs text-muted-foreground">
                      {formatWindowTime(w.start, language)}–{formatWindowTime(w.end, language)}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              {t('No delivery windows available today', 'مفيش مواعيد توصيل متاحة النهارده')}
            </p>
          )}

          {error && (
            <p role="alert" className="mt-2 text-sm text-destructive-ink">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
