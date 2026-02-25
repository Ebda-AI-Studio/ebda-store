'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Header, Footer } from '../../components';
import { useStore } from '../../contexts/StoreContext';

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

/** Format a monetary amount with the store currency. */
function formatPrice(amount: number, currency: string): string {
  return `${amount.toFixed(3)} ${currency}`;
}

export default function ShippingPage() {
  const { store } = useStore();
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
    <main className="flex min-h-screen flex-col bg-gray-50">
      <Header />

      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6 lg:px-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-gray-900">Shipping Information</h1>
          <p className="mt-2 text-gray-500">
            Everything you need to know about our shipping policies
          </p>
        </div>

        <div className="mt-12 space-y-8">
          <section className="rounded-xl border bg-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-gray-900">Shipping Options</h2>

            {/* Loading state */}
            {isLoading && (
              <div className="mt-4 flex items-center gap-2 text-sm text-gray-500">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                Loading shipping options...
              </div>
            )}

            {/* Error / no zones configured */}
            {!isLoading && (fetchError || zones.length === 0) && (
              <p className="mt-4 text-gray-600">Contact us for shipping rates.</p>
            )}

            {/* Shipping zones from API */}
            {!isLoading && zones.length > 0 && (
              <div className="mt-4 space-y-4">
                {zones.map(zone => (
                  <div key={zone.id} className="flex items-start gap-4 rounded-lg bg-gray-50 p-4">
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
                      <h3 className="font-medium text-gray-900">{zone.name}</h3>
                      {zone.areas.length > 0 && (
                        <p className="text-sm text-gray-500">{zone.areas.join(', ')}</p>
                      )}
                      <p className="text-sm text-gray-500">{formatEstimatedDays(zone)}</p>
                      {zone.deliveryFee === 0 ? (
                        <p className="mt-1 text-sm font-medium text-primary">Free Shipping</p>
                      ) : (
                        <p className="mt-1 text-sm font-medium text-gray-700">
                          {formatPrice(zone.deliveryFee, store.currency)}
                        </p>
                      )}
                      {zone.freeShippingThreshold != null && zone.freeShippingThreshold > 0 && (
                        <p className="text-sm font-medium text-primary">
                          FREE on orders over{' '}
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
            <h2 className="text-xl font-semibold text-gray-900">Order Tracking</h2>
            <p className="mt-2 text-gray-600">
              Once your order ships, you&apos;ll receive an email with your tracking number. You can
              track your package using:
            </p>
            <ul className="mt-4 space-y-2 text-gray-600">
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
                The tracking link in your shipping confirmation email
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
                Your account order history (if logged in)
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
                The carrier&apos;s website directly
              </li>
            </ul>
          </section>
        </div>

        <div className="mt-8 text-center">
          <p className="text-gray-500">
            Have questions about shipping?{' '}
            <Link href="/contact" className="text-primary hover:underline">
              Contact us
            </Link>
          </p>
        </div>
      </div>

      <Footer />
    </main>
  );
}
