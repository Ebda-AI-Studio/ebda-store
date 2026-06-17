'use client';

import { useEffect, useState } from 'react';
import { ShopChrome } from '../../components';
import { useStore } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { api } from '../../lib/api';
import { pageSurfaceStyle } from '../../lib/page-surface';
import {
  resolveSectionZone,
  zoneStyle,
  scaleZone,
  pageTextScale,
  pageDensityStyle,
} from '../../templates/shared/section-typography';
import type { LocationsPageSettings } from '@force/shared';

interface StoreLocation {
  id: string;
  name: string;
  nameAr?: string | null;
  country: string;
  countryAr?: string | null;
  address: string;
  addressAr?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  mapsUrl?: string | null;
  mapsEmbedUrl?: string | null;
  hours?: string | null;
  hoursAr?: string | null;
  isPublished: boolean;
  position: number;
}

/**
 * Defense-in-depth href guard: only allow http(s) URLs.
 * The API already validates mapsUrl via locationInputSchema, but a legacy or
 * externally-written row could carry a `javascript:`/`data:` value.
 */
const isSafeHttpUrl = (u?: string | null): boolean => {
  if (!u) return false;
  try {
    const p = new URL(u);
    return p.protocol === 'https:' || p.protocol === 'http:';
  } catch {
    return false;
  }
};

/**
 * FIX D — platform-level Arabic country name fallback for GCC/region.
 * Used when countryAr is empty and the locale is Arabic.
 */
const GCC_COUNTRY_AR: Record<string, string> = {
  Kuwait: 'الكويت',
  'U.A.E.': 'الإمارات',
  UAE: 'الإمارات',
  'United Arab Emirates': 'الإمارات',
  'Saudi Arabia': 'السعودية',
  KSA: 'السعودية',
  Qatar: 'قطر',
  Bahrain: 'البحرين',
  Oman: 'عُمان',
  Egypt: 'مصر',
};

interface LocationsClientProps {
  /** Server-fetched locationsPage layout settings (SSR-safe, no layout-flash). */
  locationsPage?: LocationsPageSettings;
}

/**
 * Storefront locations page client component. Groups published branches by
 * country and renders bilingual cards with a map-pin placeholder (FIX C — no
 * broken iframe), directions, call, and WhatsApp actions. Applies per-page
 * design settings from the Page Builder (FIX B).
 */
export default function LocationsClient({
  locationsPage: locationsPageProp,
}: LocationsClientProps) {
  const { store, layout } = useStore();
  const { isRtl, t } = useLanguage();
  const [locations, setLocations] = useState<StoreLocation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [disabled, setDisabled] = useState(false);

  // Prefer server-fetched prop (SSR, no layout-flash) over client-side context.
  const locPage = locationsPageProp ?? layout?.locationsPage;

  // Page design (page-builder → Locations page).
  const headingZone = resolveSectionZone(locPage?.typography?.heading, undefined, store.theme);
  const subtitleZone = resolveSectionZone(locPage?.typography?.subtitle, undefined, store.theme);
  const bgStyle = pageSurfaceStyle(locPage?.bgColor, store.theme, locPage?.colorScheme);
  const scale = pageTextScale(locPage?.textScale);
  const density = pageDensityStyle(locPage?.density);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setIsLoading(true);
      const res = await api.listLocations(store.id);
      if (cancelled) return;
      if (res.success && res.data) {
        setLocations(res.data.locations);
      } else if (res.error?.code === 'LOCATIONS_DISABLED' || res.error?.code === 'NOT_FOUND') {
        setDisabled(true);
      }
      setIsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [store.id]);

  // Bilingual field helper — prefer Arabic when RTL, fall back to English.
  // FIX D: for the country field, apply GCC_COUNTRY_AR lookup when countryAr is
  // missing and locale is Arabic.
  const tx = (en?: string | null, ar?: string | null) => (isRtl ? ar || en : en) || '';
  const txCountry = (en: string, ar?: string | null): string => {
    if (!isRtl) return en;
    if (ar) return ar;
    return GCC_COUNTRY_AR[en] ?? en;
  };

  // Group locations by country, preserving first-seen order.
  const grouped: { country: string; locations: StoreLocation[] }[] = [];
  const seen = new Map<string, number>();
  for (const loc of locations) {
    const key = txCountry(loc.country, loc.countryAr);
    if (!seen.has(key)) {
      seen.set(key, grouped.length);
      grouped.push({ country: key, locations: [] });
    }
    grouped[seen.get(key)!].locations.push(loc);
  }

  return (
    <ShopChrome>
      <div className="flex-1" style={bgStyle}>
        <section dir={isRtl ? 'rtl' : 'ltr'} className="py-12 sm:py-16 lg:py-20" style={density}>
          <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
            <header className="mb-8">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/50">
                {t('Branches', 'الفروع')}
              </p>
              <h1
                className="mt-1 text-3xl font-bold tracking-tight text-foreground sm:text-4xl"
                style={zoneStyle(scaleZone(headingZone, scale), scale)}
              >
                {t('Our Locations', 'فروعنا')}
              </h1>
              <p
                className="mt-2 text-sm text-muted-foreground"
                style={zoneStyle(scaleZone(subtitleZone, scale), scale)}
              >
                {t(
                  'Visit a store — tap a branch for directions, to call, or to message us.',
                  'زر أحد فروعنا — اضغط على الفرع للاتجاهات أو الاتصال أو المراسلة.'
                )}
              </p>
            </header>

            {isLoading ? (
              <p className="py-16 text-center text-sm text-foreground/60">
                {isRtl ? 'جارٍ التحميل…' : 'Loading…'}
              </p>
            ) : disabled ? (
              <p className="py-16 text-center text-sm text-foreground/60">
                {isRtl ? 'الفروع غير متاحة حالياً.' : 'Locations are not available right now.'}
              </p>
            ) : locations.length === 0 ? (
              <p className="py-16 text-center text-sm text-foreground/60">
                {isRtl ? 'لا توجد فروع بعد.' : 'No locations yet.'}
              </p>
            ) : (
              <div className="space-y-10">
                {grouped.map(group => (
                  <div key={group.country}>
                    {/* Country chip + hairline */}
                    <div className="mb-4 flex items-center gap-3">
                      <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-foreground/50">
                        {group.country}
                      </span>
                      <div className="h-px flex-1 bg-border" />
                    </div>

                    {/* Location cards grid */}
                    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                      {group.locations.map(loc => {
                        const name = tx(loc.name, loc.nameAr);
                        const address = tx(loc.address, loc.addressAr);
                        const hours = tx(loc.hours, loc.hoursAr);
                        const waNumber = loc.whatsapp ? loc.whatsapp.replace(/[^0-9]/g, '') : null;

                        return (
                          <div
                            key={loc.id}
                            className="rounded-2xl border border-border bg-card p-4"
                          >
                            {/* FIX C — replace broken Google Maps iframe with a tidy
                                map-pin placeholder. The mapsEmbedUrl ?output=embed URL
                                is refused by Google without a Maps Embed API key so
                                it renders as an empty white box in production. We show
                                a branded pin icon + keep the working "Open in Maps"
                                button (mapsUrl uses /maps/search/?api=1 which works
                                without a key). */}
                            {isSafeHttpUrl(loc.mapsUrl) && (
                              <div className="mb-3 flex h-36 w-full items-center justify-center overflow-hidden rounded-lg bg-muted">
                                {/* Simple map-pin SVG — text-muted-foreground */}
                                <svg
                                  xmlns="http://www.w3.org/2000/svg"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.5"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  className="h-10 w-10 text-muted-foreground"
                                  aria-hidden="true"
                                >
                                  <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" />
                                  <circle cx="12" cy="9" r="2.5" />
                                </svg>
                              </div>
                            )}

                            {/* Branch name */}
                            <p
                              className="text-base font-semibold text-foreground"
                              style={zoneStyle(scaleZone(subtitleZone, scale), scale)}
                            >
                              {name}
                            </p>

                            {/* Address */}
                            {address && (
                              <p className="mt-1 text-sm text-muted-foreground">{address}</p>
                            )}

                            {/* Hours */}
                            {hours && (
                              <p className="mt-1 text-sm text-muted-foreground">
                                <span className="font-medium text-foreground">
                                  {t('Hours', 'ساعات العمل')}:{' '}
                                </span>
                                {hours}
                              </p>
                            )}

                            {/* Action pills */}
                            {(isSafeHttpUrl(loc.mapsUrl) || loc.phone || waNumber) && (
                              <div className="mt-3 flex flex-wrap gap-2">
                                {isSafeHttpUrl(loc.mapsUrl) && (
                                  <a
                                    href={loc.mapsUrl!}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="rounded-full bg-primary px-3 py-1 text-sm font-medium text-primary-foreground"
                                  >
                                    {t('Open in Maps', 'افتح في الخرائط')}
                                  </a>
                                )}
                                {loc.phone && (
                                  <a
                                    href={`tel:${loc.phone}`}
                                    className="rounded-full border border-border px-3 py-1 text-sm font-medium text-foreground"
                                  >
                                    {t('Call', 'اتصال')}
                                  </a>
                                )}
                                {waNumber && (
                                  <a
                                    href={`https://wa.me/${waNumber}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="rounded-full border border-border px-3 py-1 text-sm font-medium text-foreground"
                                  >
                                    {t('WhatsApp', 'واتساب')}
                                  </a>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </ShopChrome>
  );
}
