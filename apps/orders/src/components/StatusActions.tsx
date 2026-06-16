'use client';

import { VALID_TRANSITIONS } from '@/lib/orders';
import { useLanguage } from '@/contexts/LanguageContext';

/**
 * One-tap status-advance buttons. Renders only the transitions the API will
 * accept FROM the current status (mirrors VALID_TRANSITIONS), so a merchant
 * never taps a button that 422s. `canManage` gates whether the buttons render
 * at all (staff-role awareness).
 */
export function StatusActions({
  status,
  canManage,
  isUpdating,
  onChange,
}: {
  status: string;
  canManage: boolean;
  isUpdating: boolean;
  onChange: (next: string) => void;
}) {
  const { t } = useLanguage();
  const next = VALID_TRANSITIONS[status] ?? [];

  if (!canManage) {
    return <p className="text-xs text-muted-foreground">{t.detail.readOnly}</p>;
  }
  if (next.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {next.map(s => (
        <button
          key={s}
          type="button"
          disabled={isUpdating}
          onClick={() => onChange(s)}
          className={`inline-flex h-11 flex-1 items-center justify-center rounded-full border px-4 text-sm font-semibold transition-colors active:opacity-80 disabled:opacity-50 ${
            s === 'cancelled' || s === 'refunded'
              ? 'border-destructive/40 bg-destructive/5 text-destructive'
              : 'border-primary/40 bg-primary/5 text-primary'
          }`}
        >
          {t.status[s] ?? s}
        </button>
      ))}
    </div>
  );
}
