'use client';

import { useRef, type KeyboardEvent } from 'react';
import {
  formatDeliveryDate,
  formatWindowTime12,
  type CheckoutDeliveryWindow,
  type DeliveryDateChoice,
} from '@ebda/shared';
import { useLanguage } from '../../../contexts/LanguageContext';

/**
 * One radio group of 44px chips (the WAI-ARIA radio pattern: roving tabindex, arrows move AND
 * select, RTL-aware, Home/End). The selected chip is filled AND carries a check, so the state is
 * never colour alone.
 */
function ChipRadioGroup<T extends { key: string; disabled?: boolean }>({
  label,
  items,
  selectedKey,
  onSelect,
  render,
}: {
  label: string;
  items: T[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  render: (item: T, selected: boolean) => React.ReactNode;
}) {
  const { isRtl } = useLanguage();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const enabled = items.filter(i => !i.disabled);
  const tabbable =
    selectedKey && enabled.some(i => i.key === selectedKey) ? selectedKey : enabled[0]?.key;
  const move = (from: string, step: number) => {
    const i = enabled.findIndex(x => x.key === from);
    const next = enabled[(i + step + enabled.length) % enabled.length];
    if (!next) return;
    onSelect(next.key);
    refs.current[next.key]?.focus();
  };
  const onKey = (e: KeyboardEvent, key: string) => {
    const fwd = isRtl ? 'ArrowLeft' : 'ArrowRight';
    const back = isRtl ? 'ArrowRight' : 'ArrowLeft';
    if (e.key === fwd || e.key === 'ArrowDown') (e.preventDefault(), move(key, 1));
    else if (e.key === back || e.key === 'ArrowUp') (e.preventDefault(), move(key, -1));
    else if (e.key === 'Home')
      (e.preventDefault(), move(enabled[enabled.length - 1]?.key ?? key, 1));
    else if (e.key === 'End') (e.preventDefault(), move(enabled[0]?.key ?? key, -1));
  };
  return (
    <div role="radiogroup" aria-label={label} className="mt-2 flex flex-wrap gap-2">
      {items.map(item => {
        const selected = selectedKey === item.key;
        return (
          <button
            key={item.key}
            ref={el => {
              refs.current[item.key] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={item.disabled}
            tabIndex={item.key === tabbable ? 0 : -1}
            onClick={() => onSelect(item.key)}
            onKeyDown={e => onKey(e, item.key)}
            data-chip=""
            className={`inline-flex min-h-11 min-w-11 items-center gap-1.5 rounded-[var(--radius)] border-2 px-3 py-2 text-start text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
              selected
                ? 'border-primary bg-primary text-primary-foreground'
                : item.disabled
                  ? 'cursor-not-allowed border-input/50 text-muted-foreground opacity-50'
                  : 'border-input bg-background text-foreground hover:border-foreground/40'
            }`}
          >
            {selected && (
              <svg
                className="h-4 w-4 shrink-0"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={3}
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            )}
            {render(item, selected)}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Date chips + window chips for a store with `checkoutDelivery.daysAhead` (Phase B4, Ruling B4-7).
 * The dates are `deliveryDateChoices` and the server recomputes them at order time; the first two
 * read "النهاردة" / "بكرة" (today / tomorrow) with the date beneath, the rest are the date. When no
 * date is offered the shopper is told in a sentence and checkout is never blocked on it.
 */
export function DeliveryDateChips({
  choices,
  windows,
  selectedDate,
  selectedWindowId,
  onSelectDate,
  onSelectWindow,
  error,
}: {
  choices: DeliveryDateChoice[];
  /** The store's configured windows (empty when windows are off). */
  windows: CheckoutDeliveryWindow[];
  selectedDate: string | null;
  selectedWindowId: string | null;
  onSelectDate: (date: string) => void;
  onSelectWindow: (id: string) => void;
  error?: string | null;
}) {
  const { language, t } = useLanguage();
  if (choices.length === 0)
    return (
      <p className="mt-2 text-sm text-muted-foreground">
        {t('No delivery dates are available right now', 'مفيش مواعيد توصيل متاحة دلوقتي')}
      </p>
    );
  const chosen = choices.find(c => c.date === selectedDate) ?? null;
  const word = (c: DeliveryDateChoice) =>
    c.offset === 0 ? t('Today', 'النهاردة') : c.offset === 1 ? t('Tomorrow', 'بكرة') : null;
  return (
    <div>
      <ChipRadioGroup
        label={t('Delivery date', 'يوم التوصيل')}
        items={choices.map(c => ({ key: c.date, choice: c }))}
        selectedKey={selectedDate}
        onSelect={onSelectDate}
        render={item => {
          const c = item.choice;
          const w = word(c);
          return (
            <span className="flex flex-col leading-tight">
              <span className="font-medium">{w ?? formatDeliveryDate(c.date, language)}</span>
              {w && (
                <span className="text-xs opacity-80">{formatDeliveryDate(c.date, language)}</span>
              )}
            </span>
          );
        }}
      />
      {windows.length > 0 && chosen && (
        <div className="mt-3">
          <h4 className="text-sm font-medium text-foreground">
            {t('Delivery window', 'موعد التوصيل')}
          </h4>
          <ChipRadioGroup
            label={t('Delivery window', 'موعد التوصيل')}
            items={windows.map(w => ({
              key: w.id,
              win: w,
              disabled: !chosen.windows.find(x => x.id === w.id)?.available,
            }))}
            selectedKey={selectedWindowId}
            onSelect={onSelectWindow}
            render={item => (
              <span className="flex flex-col leading-tight">
                <span className="font-medium">
                  {language === 'ar' ? item.win.labelAr || item.win.label : item.win.label}
                </span>
                <span className="text-xs opacity-80">
                  {formatWindowTime12(item.win.start, language)}–
                  {formatWindowTime12(item.win.end, language)}
                </span>
              </span>
            )}
          />
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive-ink">
          {error}
        </p>
      )}
    </div>
  );
}
