'use client';
import { useEffect, useState } from 'react';
import { deliveryDaysSchema, deliveryWindow } from '@ebda/shared';
import { useLanguage } from '@/contexts/LanguageContext';
import { useStore } from '@/contexts/StoreContext';
import { useStoreNumerals, useNumerals } from '@/hooks/useNumerals';
import { formatDate } from '@/lib/format-date';
import { fetchPublicShippingZones } from '@/lib/shipping-public';

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

/** "in N days" tail of the made-to-order line, with Arabic noun agreement: يوم / يومين / N أيام / N يوم. */
function leadTimeText(n: number, lang: 'ar' | 'en', localize: (v: number) => string): string {
  if (lang === 'en') return `Made for you in ${n} ${n === 1 ? 'day' : 'days'}`;
  const days =
    n === 1 ? 'يوم' : n === 2 ? 'يومين' : n <= 10 ? `${localize(n)} أيام` : `${localize(n)} يوم`;
  return `بيتجهز خصيصًا لك في ${days}`;
}

/**
 * "Arrives Sun 19 Oct – Tue 21 Oct" under the add-to-cart button, plus one muted line when
 * the product is made to order. Business days (Fridays skipped) from the store's active
 * shipping zones, else the store-wide `settings.deliveryDays`. Hides itself when neither
 * has numbers (never "0 days"). Ink/muted tokens only: the accent belongs to the CTA.
 */
export function DeliveryChip({ leadTimeDays }: { leadTimeDays?: number | null }) {
  const { language, t } = useLanguage();
  const { store } = useStore();
  const numerals = useStoreNumerals();
  const { localize } = useNumerals();
  const [zones, setZones] = useState<Zones | null>(null);
  // `now` is read after mount: a server-rendered date would mismatch on hydration.
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

  if (!zones || !now) return null;

  const rawFallback = (store.settings as { deliveryDays?: unknown } | undefined)?.deliveryDays;
  const parsed = deliveryDaysSchema.safeParse(rawFallback);
  const lead = typeof leadTimeDays === 'number' && leadTimeDays > 0 ? leadTimeDays : null;
  const w = deliveryWindow({
    now,
    leadTimeDays: lead,
    zones: zones.map(z => ({
      isActive: true, // the public endpoint only returns active zones
      estimatedDaysMin: z.estimatedDaysMin,
      estimatedDaysMax: z.estimatedDaysMax,
      estimatedDays: z.estimatedDays,
    })),
    fallback: parsed.success ? parsed.data : null,
    timeZone: store.timezone,
  });
  if (!w) return null;

  const fmt = (d: Date) =>
    formatDate(d, {
      timezone: store.timezone,
      language: language === 'ar' ? 'ar' : 'en',
      numerals,
      style: 'day',
    });
  const from = fmt(w.from);
  const to = fmt(w.to);
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
