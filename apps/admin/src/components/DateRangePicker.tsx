'use client';

import { Button } from '@/components/ui/Button';
import { useState, useEffect } from 'react';
import { useT } from '@/i18n/useT';
import { ANALYTICS_PERIOD_PRESETS } from '@ebda/shared';
import type { Period, ResolvedDateRange } from '../app/stores/[id]/analytics/_components/types';
import { resolveDateRange } from '../app/stores/[id]/analytics/_components/types';

interface DateRangePickerProps {
  period: Period;
  custom?: ResolvedDateRange;
  onChange: (period: Period, custom?: ResolvedDateRange) => void;
  /** When set, hides the listed presets. Useful for cases where some
   *  presets don't make sense (e.g. 'today' on a year-aggregated chart). */
  exclude?: Period[];
}

// The shared list is the one checklist the API enum and the
// `analytics.periodsSubtitle.*` i18n keys are tested against.
const PRESET_ORDER: Period[] = [...ANALYTICS_PERIOD_PRESETS];

const PRESET_LABELS: Record<Period, { en: string; ar: string }> = {
  today: { en: 'Today', ar: 'اليوم' },
  yesterday: { en: 'Yesterday', ar: 'أمس' },
  last_7: { en: 'Last 7 days', ar: 'آخر 7 أيام' },
  last_30: { en: 'Last 30 days', ar: 'آخر 30 يوم' },
  last_90: { en: 'Last 90 days', ar: 'آخر 90 يوم' },
  this_month: { en: 'This month', ar: 'هذا الشهر' },
  last_month: { en: 'Last month', ar: 'الشهر الماضي' },
  this_year: { en: 'This year', ar: 'هذه السنة' },
  custom: { en: 'Custom', ar: 'مخصص' },
  // legacy aliases
  week: { en: 'Last 7 days', ar: 'آخر 7 أيام' },
  month: { en: 'This month', ar: 'هذا الشهر' },
  year: { en: 'This year', ar: 'هذه السنة' },
};

function toInputDate(d: Date): string {
  // yyyy-mm-dd in local time (HTML date input format).
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function fromInputDate(s: string): Date | null {
  const match = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0);
}

function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

/**
 * Reusable 9-preset date range picker. Replaces AnalyticsDateRange.
 * - Preset pills: today / yesterday / last 7-30-90 days / this+last month / this year / custom
 * - Custom mode reveals a pair of date inputs (start + end)
 *
 * State shape: parent owns `period` and optional `custom` range. When
 * preset != 'custom', `custom` is ignored. When 'custom' is selected
 * with no `custom` value, picker initializes with last-30-day defaults.
 */
export function DateRangePicker({ period, custom, onChange, exclude = [] }: DateRangePickerProps) {
  const t = useT('analytics');
  const isRtl = typeof document !== 'undefined' && document.documentElement.dir === 'rtl';

  // Custom range inputs — initialize with sensible defaults so the merchant
  // sees something pre-filled when first switching to Custom mode.
  const [customStart, setCustomStart] = useState<string>(() =>
    custom ? toInputDate(custom.startDate) : toInputDate(resolveDateRange('last_30').startDate)
  );
  const [customEnd, setCustomEnd] = useState<string>(() =>
    custom ? toInputDate(custom.endDate) : toInputDate(resolveDateRange('last_30').endDate)
  );

  // Sync local inputs when parent's custom changes (URL hydration etc.)
  useEffect(() => {
    if (custom) {
      setCustomStart(toInputDate(custom.startDate));
      setCustomEnd(toInputDate(custom.endDate));
    }
  }, [custom?.startDate, custom?.endDate]);

  const presets = PRESET_ORDER.filter(p => !exclude.includes(p));
  const labelFor = (p: Period) => (isRtl ? PRESET_LABELS[p].ar : PRESET_LABELS[p].en);
  void t; // reserved for future i18n key lookup; for now use PRESET_LABELS

  const handlePresetClick = (p: Period) => {
    if (p === 'custom') {
      const s = fromInputDate(customStart);
      const e = fromInputDate(customEnd);
      if (s && e) onChange('custom', { startDate: s, endDate: endOfDay(e) });
      else onChange('custom');
    } else {
      onChange(p);
    }
  };

  const handleCustomChange = (nextStart: string, nextEnd: string) => {
    setCustomStart(nextStart);
    setCustomEnd(nextEnd);
    const s = fromInputDate(nextStart);
    const e = fromInputDate(nextEnd);
    if (s && e && s.getTime() <= e.getTime()) {
      onChange('custom', { startDate: s, endDate: endOfDay(e) });
    }
  };

  return (
    <div className="mb-6 space-y-3">
      <div className="flex flex-wrap items-center gap-1 rounded-xl bg-muted p-1 w-fit">
        {presets.map(p => {
          // 'week' / 'month' / 'year' map to the new equivalents for active highlight.
          const isActive =
            period === p ||
            (p === 'last_7' && period === 'week') ||
            (p === 'this_month' && period === 'month') ||
            (p === 'this_year' && period === 'year');
          return (
            <Button
              variant={isActive ? 'soft' : 'ghost'}
              size="sm"
              type="button"
              key={p}
              onClick={() => handlePresetClick(p)}
            >
              {labelFor(p)}
            </Button>
          );
        })}
      </div>
      {period === 'custom' && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('dateFrom')}
            <input
              type="date"
              value={customStart}
              onChange={e => handleCustomChange(e.target.value, customEnd)}
              max={customEnd}
              className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('dateTo')}
            <input
              type="date"
              value={customEnd}
              onChange={e => handleCustomChange(customStart, e.target.value)}
              min={customStart}
              className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
            />
          </label>
        </div>
      )}
    </div>
  );
}
