'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Header, Footer } from '../../components';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1';

interface ShippingZone {
  id: string;
  name: string;
  nameAr?: string;
  areas: string[];
  areasAr?: string[];
  deliveryFee: number;
  freeShippingThreshold?: number | null;
  estimatedDays?: number | null;
  estimatedDaysMin?: number | null;
  estimatedDaysMax?: number | null;
}

/** Format a delivery time range into a human-readable string. */
function formatEstimatedDays(zone: ShippingZone): string {
  if (zone.estimatedDaysMin && zone.estimatedDaysMax) {
    return `${zone.estimatedDaysMin}–${zone.estimatedDaysMax} business days`;
  }
  if (zone.estimatedDays) {
    return `${zone.estimatedDays} business day${zone.estimatedDays !== 1 ? 's' : ''}`;
  }
  return 'Delivery time varies';
}

/** Format a monetary amount (stored in fils) with the store currency. */
function formatPrice(fils: number, currency: string): string {
  const divisor = currency === 'KWD' ? 1000 : 100;
  const decimals = currency === 'KWD' ? 3 : 2;
  return new Intl.NumberFormat('en-KW', {
    style: 'currency',
    currency: currency,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(fils / divisor);
}

export default function ShippingPage() {
  const { store } = useStore();
  const storeUrl = useStoreUrl();
  const { language, t } = useLanguage();
  const [zones, setZones] = useState<ShippingZone[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);

  useEffect(() => {
    // Only fetch once we have a real store id (not the default 'demo' placeholder)
    if (!store.id || store.id === 'demo') return;

    setIsLoading(true);
    setFetchError(false);

    fetch(`${API_URL}/stores/public/${store.id}/shipping`)
      .then(res => res.json())
      .then(json => {
        if (json.success && Array.isArray(json.data?.zones)) {
          setZones(json.data.zones);
        } else {
          setFetchError(true);
        }
      })
      .catch(() => setFetchError(true))
      .finally(() => setIsLoading(false));
  }, [store.id]);

  return (
    <main className="flex min-h-screen flex-col bg-background">
      <Header />

      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6 lg:px-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-foreground">
            {t('Shipping Information', 'معلومات الشحن')}
          </h1>
          <p className="mt-2 text-muted-foreground">
            {t(
              'Everything you need to know about our shipping policies',
              'كل ما تحتاج معرفته عن سياسات الشحن لدينا'
            )}
          </p>
        </div>

        <div className="mt-12 space-y-8">
          <section className="rounded-xl border bg-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-foreground">
              {t('Shipping Options', 'خيارات الشحن')}
            </h2>

            {/* Loading state */}
            {isLoading && (
              <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                {t('Loading shipping options...', 'جاري تحميل خيارات الشحن...')}
              </div>
            )}

            {/* Error / no zones configured */}
            {!isLoading && (fetchError || zones.length === 0) && (
              <p className="mt-4 text-muted-foreground">
                {t('Contact us for shipping rates.', 'تواصل معنا لمعرفة أسعار الشحن.')}
              </p>
            )}

            {/* Shipping zones from API */}
            {!isLoading && zones.length > 0 && (
              <div className="mt-4 space-y-4">
                {zones.map(zone => (
                  <div key={zone.id} className="flex items-start gap-4 rounded-lg bg-muted p-4">
                    <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-primary/10">
                      <svg
                        className="h-5 w-5 text-primary"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                        />
                      </svg>
                    </div>
                    <div>
                      <h3 className="font-medium text-foreground">
                        {language === 'ar' && zone.nameAr ? zone.nameAr : zone.name}
                      </h3>
                      {zone.areas.length > 0 && (
                        <p className="text-sm text-muted-foreground">
                          {language === 'ar' && zone.areasAr
                            ? zone.areasAr.join(', ')
                            : zone.areas.join(', ')}
                        </p>
                      )}
                      <p className="text-sm text-muted-foreground">{formatEstimatedDays(zone)}</p>
                      {zone.deliveryFee === 0 ? (
                        <p className="mt-1 text-sm font-medium text-primary">
                          {t('Free Shipping', 'شحن مجاني')}
                        </p>
                      ) : (
                        <p className="mt-1 text-sm font-medium text-foreground">
                          {formatPrice(zone.deliveryFee, store.currency)}
                        </p>
                      )}
                      {zone.freeShippingThreshold != null && zone.freeShippingThreshold > 0 && (
                        <p className="text-sm font-medium text-primary">
                          {t('FREE on orders over', 'مجاني للطلبات أكثر من')}{' '}
                          {formatPrice(zone.freeShippingThreshold, store.currency)}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-xl border bg-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-foreground">
              {t('Order Tracking', 'تتبع الطلب')}
            </h2>
            <p className="mt-2 text-muted-foreground">
              {t(
                "Once your order ships, you'll receive an email with your tracking number. You can track your package using:",
                'بمجرد شحن طلبك، ستتلقى بريداً إلكترونياً يحتوي على رقم التتبع. يمكنك تتبع طردك باستخدام:'
              )}
            </p>
            <ul className="mt-4 space-y-2 text-muted-foreground">
              <li className="flex items-center gap-2">
                <svg
                  className="h-4 w-4 text-primary"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                {t(
                  'The tracking link in your shipping confirmation email',
                  'رابط التتبع في بريد تأكيد الشحن'
                )}
              </li>
              <li className="flex items-center gap-2">
                <svg
                  className="h-4 w-4 text-primary"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                {t('Your account order history (if logged in)', 'سجل طلبات حسابك (إذا كنت مسجلاً)')}
              </li>
              <li className="flex items-center gap-2">
                <svg
                  className="h-4 w-4 text-primary"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                {t("The carrier's website directly", 'موقع شركة الشحن مباشرة')}
              </li>
            </ul>
          </section>
        </div>

        <div className="mt-8 text-center">
          <p className="text-muted-foreground">
            {t('Have questions about shipping?', 'هل لديك أسئلة حول الشحن؟')}{' '}
            <Link href={storeUrl('/contact')} className="text-primary hover:underline">
              {t('Contact us', 'تواصل معنا')}
            </Link>
          </p>
        </div>
      </div>

      <Footer />
    </main>
  );
}
