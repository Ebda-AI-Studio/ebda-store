'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ShopChrome } from '../../components';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { API_URL } from '../../lib/api';
import { formatPrice as formatPriceBase } from '../../lib/format';

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
    return `${zone.estimatedDaysMin}\u2013${zone.estimatedDaysMax} business days`;
  }
  if (zone.estimatedDays) {
    return `${zone.estimatedDays} business day${zone.estimatedDays !== 1 ? 's' : ''}`;
  }
  return 'Delivery time varies';
}

export default function ShippingClient() {
  const { store } = useStore();
  const storeUrl = useStoreUrl();
  const { language, t } = useLanguage();
  // Locale-aware wrapper so Arabic-locale shoppers see Arabic-Indic digits
  // (formatPriceBase defaults to Western digits when no locale is passed).
  const formatPrice = (amount: number) =>
    formatPriceBase(amount, {
      locale: language === 'ar' && store?.theme?.arabicNumerals === true ? 'ar' : 'en',
    });
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
    <ShopChrome>
      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6 lg:px-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-foreground">
            {t(
              'Shipping Information',
              '\u0645\u0639\u0644\u0648\u0645\u0627\u062a \u0627\u0644\u0634\u062d\u0646'
            )}
          </h1>
          <p className="mt-2 text-muted-foreground">
            {t(
              'Everything you need to know about our shipping policies',
              '\u0643\u0644 \u0645\u0627 \u062a\u062d\u062a\u0627\u062c \u0645\u0639\u0631\u0641\u062a\u0647 \u0639\u0646 \u0633\u064a\u0627\u0633\u0627\u062a \u0627\u0644\u0634\u062d\u0646 \u0644\u062f\u064a\u0646\u0627'
            )}
          </p>
        </div>

        <div className="mt-12 space-y-8">
          <section className="rounded-xl border bg-card p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-foreground">
              {t(
                'Shipping Options',
                '\u062e\u064a\u0627\u0631\u0627\u062a \u0627\u0644\u0634\u062d\u0646'
              )}
            </h2>

            {/* Loading state */}
            {isLoading && (
              <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                {t(
                  'Loading shipping options...',
                  '\u062c\u0627\u0631\u064a \u062a\u062d\u0645\u064a\u0644 \u062e\u064a\u0627\u0631\u0627\u062a \u0627\u0644\u0634\u062d\u0646...'
                )}
              </div>
            )}

            {/* Error / no zones configured */}
            {!isLoading && (fetchError || zones.length === 0) && (
              <p className="mt-4 text-muted-foreground">
                {t(
                  'Contact us for shipping rates.',
                  '\u062a\u0648\u0627\u0635\u0644 \u0645\u0639\u0646\u0627 \u0644\u0645\u0639\u0631\u0641\u0629 \u0623\u0633\u0639\u0627\u0631 \u0627\u0644\u0634\u062d\u0646.'
                )}
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
                          {t('Free Shipping', '\u0634\u062d\u0646 \u0645\u062c\u0627\u0646\u064a')}
                        </p>
                      ) : (
                        <p className="mt-1 text-sm font-medium text-foreground">
                          {formatPrice(zone.deliveryFee)}
                        </p>
                      )}
                      {zone.freeShippingThreshold != null && zone.freeShippingThreshold > 0 && (
                        <p className="text-sm font-medium text-primary">
                          {t(
                            'FREE on orders over',
                            '\u0645\u062c\u0627\u0646\u064a \u0644\u0644\u0637\u0644\u0628\u0627\u062a \u0623\u0643\u062b\u0631 \u0645\u0646'
                          )}{' '}
                          {formatPrice(zone.freeShippingThreshold!)}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-xl border bg-card p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-foreground">
              {t('Order Tracking', '\u062a\u062a\u0628\u0639 \u0627\u0644\u0637\u0644\u0628')}
            </h2>
            <p className="mt-2 text-muted-foreground">
              {t(
                "Once your order ships, you'll receive an email with your tracking number. You can track your package using:",
                '\u0628\u0645\u062c\u0631\u062f \u0634\u062d\u0646 \u0637\u0644\u0628\u0643\u060c \u0633\u062a\u062a\u0644\u0642\u0649 \u0628\u0631\u064a\u062f\u0627\u064b \u0625\u0644\u0643\u062a\u0631\u0648\u0646\u064a\u0627\u064b \u064a\u062d\u062a\u0648\u064a \u0639\u0644\u0649 \u0631\u0642\u0645 \u0627\u0644\u062a\u062a\u0628\u0639. \u064a\u0645\u0643\u0646\u0643 \u062a\u062a\u0628\u0639 \u0637\u0631\u062f\u0643 \u0628\u0627\u0633\u062a\u062e\u062f\u0627\u0645:'
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
                  '\u0631\u0627\u0628\u0637 \u0627\u0644\u062a\u062a\u0628\u0639 \u0641\u064a \u0628\u0631\u064a\u062f \u062a\u0623\u0643\u064a\u062f \u0627\u0644\u0634\u062d\u0646'
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
                {t(
                  'Your account order history (if logged in)',
                  '\u0633\u062c\u0644 \u0637\u0644\u0628\u0627\u062a \u062d\u0633\u0627\u0628\u0643 (\u0625\u0630\u0627 \u0643\u0646\u062a \u0645\u0633\u062c\u0644\u0627\u064b)'
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
                {t(
                  "The carrier's website directly",
                  '\u0645\u0648\u0642\u0639 \u0634\u0631\u0643\u0629 \u0627\u0644\u0634\u062d\u0646 \u0645\u0628\u0627\u0634\u0631\u0629'
                )}
              </li>
            </ul>
          </section>
        </div>

        <div className="mt-8 text-center">
          <p className="text-muted-foreground">
            {t(
              'Have questions about shipping?',
              '\u0647\u0644 \u0644\u062f\u064a\u0643 \u0623\u0633\u0626\u0644\u0629 \u062d\u0648\u0644 \u0627\u0644\u0634\u062d\u0646\u061f'
            )}{' '}
            <Link href={storeUrl('/contact')} className="text-primary hover:underline">
              {t('Contact us', '\u062a\u0648\u0627\u0635\u0644 \u0645\u0639\u0646\u0627')}
            </Link>
          </p>
        </div>
      </div>
    </ShopChrome>
  );
}
