'use client';

/**
 * AffiliateTracker
 *
 * Client component that detects ?ref=CODE in the URL and:
 * 1. Sets an affiliate_ref cookie (30-day expiry) if not already set this session.
 * 2. Calls GET /api/v1/public/:storeId/affiliates/track?ref=CODE to register the click.
 *
 * This component renders nothing — it is purely side-effect-based.
 * Mount it once in the root layout inside StoreProvider/FeatureProvider.
 */

import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { useStore } from '../contexts/StoreContext';
import { API_URL } from '../lib/api';

export function AffiliateTracker() {
  const { store } = useStore();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!store?.id || store.id === 'demo') return;

    const ref = searchParams?.get('ref');
    if (!ref) return;

    const cookieName = 'affiliate_ref';

    // Only track once — if cookie already set, skip
    const alreadySet = document.cookie
      .split(';')
      .map(c => c.trim())
      .some(c => c.startsWith(`${cookieName}=`));

    if (alreadySet) return;

    // Persist the referral code for 30 days
    const expires = new Date();
    expires.setDate(expires.getDate() + 30);
    document.cookie = `${cookieName}=${encodeURIComponent(ref)}; expires=${expires.toUTCString()}; path=/; SameSite=Lax`;

    // Register the click server-side (fire-and-forget)
    fetch(`${API_URL}/public/${store.id}/affiliates/track?ref=${encodeURIComponent(ref)}`, {
      method: 'GET',
    }).catch(() => {
      // Silently ignore — tracking should never break the user experience
    });
  }, [store?.id, searchParams]);

  return null;
}
