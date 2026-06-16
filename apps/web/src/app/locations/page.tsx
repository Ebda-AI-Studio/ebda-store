'use client';

import { useEffect, useState } from 'react';
import { ShopChrome } from '../../components';
import { useStore } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { api } from '../../lib/api';

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
 * Defense-in-depth href/iframe-src guard: only allow http(s) URLs to be
 * rendered. The API already validates mapsUrl/mapsEmbedUrl via
 * locationInputSchema, but a legacy or externally-written row could carry a
 * `javascript:`/`data:` value — never paint one into the DOM (matches the
 * heroCtaLink scheme-validation rule).
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
 * Storefront locations page. Groups published branches by country and renders
 * bilingual cards with map embed, directions, call, and WhatsApp actions.
 * Mirrors the blog page pattern (client-side, useStore + useLanguage + api).
 */
export default function LocationsPage() {
  const { store } = useStore();
  const { isRtl, t } = useLanguage();
  const [locations, setLocations] = useState<StoreLocation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [disabled, setDisabled] = useState(false);

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

  // Bilingual field helper — prefer Arabic when RTL, fall back to English
  const tx = (en?: string | null, ar?: string | null) => (isRtl ? ar || en : en) || '';

  // Group locations by country, preserving first-seen order
  const grouped: { country: string; locations: StoreLocation[] }[] = [];
  const seen = new Map<string, number>();
  for (const loc of locations) {
    const key = tx(loc.country, loc.countryAr);
    if (!seen.has(key)) {
      seen.set(key, grouped.length);
      grouped.push({ country: key, locations: [] });
    }
    grouped[seen.get(key)!].locations.push(loc);
  }

  return (
    <ShopChrome>
      <section dir={isRtl ? 'rtl' : 'ltr'} className="bg-background py-12 sm:py-16 lg:py-20">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
          <header className="mb-8">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/50">
              {t('Branches', 'الفروع')}
            </p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
              {t('Our Locations', 'فروعنا')}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
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
                        <div key={loc.id} className="rounded-2xl border border-border bg-card p-4">
                          {/* Map embed */}
                          {isSafeHttpUrl(loc.mapsEmbedUrl) && (
                            <div className="mb-3 overflow-hidden rounded-lg">
                              <iframe
                                src={loc.mapsEmbedUrl!}
                                title={name}
                                className="h-36 w-full grayscale opacity-80 transition-all duration-700 hover:grayscale-0"
                                loading="lazy"
                                referrerPolicy="no-referrer-when-downgrade"
                              />
                            </div>
                          )}

                          {/* Branch name */}
                          <p className="text-base font-semibold text-foreground">{name}</p>

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
    </ShopChrome>
  );
}
