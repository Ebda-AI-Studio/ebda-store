'use client';
import { useEffect, useState } from 'react';
import { deliveryDaysSchema, deliveryOffDaysSchema, deliveryWindow } from '@ebda/shared';
import { useLanguage } from '@/contexts/LanguageContext';
import { useStore } from '@/contexts/StoreContext';
import { useStoreNumerals, useNumerals } from '@/hooks/useNumerals';
import { formatDate } from '@/lib/format-date';
import { fetchPublicShippingZones } from '@/lib/shipping-public';
import { countText, DAYS } from '@/lib/plural';

type Zones = Awaited<ReturnType<typeof fetchPublicShippingZones>>;

// One zones request per store per page session (PDP re-renders on every variant tap).
const zonesCache = new Map<string, Promise<Zones>>();
function zonesFor(storeId: string): Promise<Zones> {
  let p = zonesCache.get(storeId);
  if (!p) {
    p = fetchPublicShippingZones(storeId).catch(() => []);
    zonesCache.set(storeId, p);
  }
  return p;
}

/** "in N days" tail of the made-to-order line, through the one plural helper (Y-01). */
function leadTimeText(n: number, lang: 'ar' | 'en', localize: (v: number) => string): string {
  if (lang === 'en') return `Made for you in ${countText('en', n, DAYS)}`;
  return `بيتجهز خصيصًا لك في ${countText('ar', n, DAYS, localize(n))}`;
}

/**
 * The store's delivery window, formatted for the render ("Sun 19 Oct" … in the
 * shopper's language and digits): business days (the store's `deliveryOffDays`
 * skipped, Friday by default) from the store's active shipping zones, else the
 * store-wide `settings.deliveryDays`, plus a made-to-order lead time. `from` is
 * the day the clock starts (now on the PDP, the order's date on the receipt);
 * null until mounted (a server-rendered date would mismatch on hydration).
 * Returns null when the store has no numbers (never "0 days").
 */
export function useDeliveryWindow({
  leadTimeDays,
  from: start,
}: {
  leadTimeDays?: number | null;
  /** When the window starts; omitted = now (read after mount). null = not yet known. */
  from?: Date | null;
} = {}): { from: string; to: string } | null {
  const { language } = useLanguage();
  const { store } = useStore();
  const numerals = useStoreNumerals();
  const [zones, setZones] = useState<Zones | null>(null);
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    let live = true;
    setNow(new Date());
    zonesFor(store.id).then(z => {
      if (live) setZones(z);
    });
    return () => {
      live = false;
    };
  }, [store.id]);

  const clock = start === undefined ? now : start;
  if (!zones || !now || !clock || Number.isNaN(clock.getTime())) return null;

  const sets = store.settings as { deliveryDays?: unknown; deliveryOffDays?: unknown } | undefined;
  const parsed = deliveryDaysSchema.safeParse(sets?.deliveryDays);
  const offParsed = deliveryOffDaysSchema.safeParse(sets?.deliveryOffDays);
  const lead = typeof leadTimeDays === 'number' && leadTimeDays > 0 ? leadTimeDays : null;
  const w = deliveryWindow({
    now: clock,
    leadTimeDays: lead,
    zones: zones.map(z => ({
      isActive: true, // the public endpoint only returns active zones
      estimatedDaysMin: z.estimatedDaysMin,
      estimatedDaysMax: z.estimatedDaysMax,
      estimatedDays: z.estimatedDays,
    })),
    fallback: parsed.success ? parsed.data : null,
    timeZone: store.timezone,
    offDays: offParsed.success ? offParsed.data : null,
  });
  if (!w) return null;

  const fmt = (d: Date) =>
    formatDate(d, {
      timezone: store.timezone,
      language: language === 'ar' ? 'ar' : 'en',
      numerals,
      style: 'day',
    });
  return { from: fmt(w.from), to: fmt(w.to) };
}

/**
 * "Arrives Sun 19 Oct – Tue 21 Oct" under the add-to-cart button, plus one muted line when
 * the product is made to order (`useDeliveryWindow`). Hides itself when the store has no
 * numbers. Ink/muted tokens only: the accent belongs to the CTA.
 */
export function DeliveryChip({ leadTimeDays }: { leadTimeDays?: number | null }) {
  const { language, t } = useLanguage();
  const { localize } = useNumerals();
  const win = useDeliveryWindow({ leadTimeDays });
  if (!win) return null;
  const lead = typeof leadTimeDays === 'number' && leadTimeDays > 0 ? leadTimeDays : null;
  const { from, to } = win;
  const text =
    from === to
      ? t(`Arrives ${from}`, `يوصلك ${from}`)
      : t(`Arrives ${from} – ${to}`, `يوصلك بين ${from} و${to}`);

  return (
    <div data-testid="delivery-chip" className="mt-3 flex items-start gap-2 text-foreground">
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
      >
        <path d="M9 17a2 2 0 11-4 0 2 2 0 014 0zM19 17a2 2 0 11-4 0 2 2 0 014 0zM13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h1m8-1a1 1 0 01-1 1H9m4-1V8a1 1 0 011-1h2.586a1 1 0 01.707.293l3.414 3.414a1 1 0 01.293.707V16a1 1 0 01-1 1h-1m-6-1a1 1 0 001 1h1" />
      </svg>
      <div className="min-w-0">
        <p className="text-sm">{text}</p>
        {lead && (
          <p className="text-xs text-muted-foreground">
            {leadTimeText(lead, language === 'ar' ? 'ar' : 'en', localize)}
          </p>
        )}
      </div>
    </div>
  );
}
