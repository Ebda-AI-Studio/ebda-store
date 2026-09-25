'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { useFeatures } from '../contexts/FeatureContext';
import { useStore } from '../contexts/StoreContext';

export interface WalletSummary {
  balance: number;
  /** The store lets this customer spend the balance at checkout. */
  checkoutAvailable: boolean;
}

/**
 * Customer wallet (store credit, D1) summary for the signed-in shopper.
 *
 * Returns `null` — and every wallet surface renders nothing — unless the API
 * itself confirms the wallet. `enabledFeatures` alone is not trusted: it rides
 * the edge-cached store payload, so right after a deploy (or a super-admin
 * toggle) it can still say "on" for a store whose wallet the API has already
 * switched off. Only a 200 from the wallet endpoint shows the UI, which keeps
 * the storefront of a store without the feature exactly as it was.
 *
 * A short cache stops the account layout, the wallet page and checkout from
 * each re-fetching within one visit. It is keyed on the store AND the signed-in
 * customer: keyed on the store alone, a second shopper signing in on the same
 * browser within the window (a shared device, or logout → login without a
 * reload) would be shown the previous shopper's balance.
 */
const CACHE_MS = 15_000;
const cache = new Map<string, { at: number; value: Promise<WalletSummary | null> }>();

function fetchSummary(
  storeId: string,
  customerId: string,
  force = false
): Promise<WalletSummary | null> {
  const key = `${storeId}:${customerId}`;
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = api
    .getWallet(storeId)
    .then(res =>
      res.success && res.data
        ? { balance: res.data.balance, checkoutAvailable: res.data.checkoutAvailable }
        : null
    )
    .catch(() => null);
  cache.set(key, { at: Date.now(), value });
  return value;
}

export function useWallet(): {
  wallet: WalletSummary | null;
  isLoading: boolean;
  refresh: () => void;
} {
  const { isAuthenticated, user } = useAuth();
  const { isEnabled } = useFeatures();
  const { store } = useStore();
  const storeId = store?.id;
  const customerId = user?.id;
  const eligible =
    isAuthenticated &&
    !!customerId &&
    !!storeId &&
    storeId !== 'demo' &&
    isEnabled('customer_wallet');

  const [wallet, setWallet] = useState<WalletSummary | null>(null);
  const [isLoading, setIsLoading] = useState(eligible);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!eligible || !storeId || !customerId) {
      setWallet(null);
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    fetchSummary(storeId, customerId, nonce > 0).then(value => {
      if (cancelled) return;
      setWallet(value);
      setIsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [eligible, storeId, customerId, nonce]);

  const refresh = useCallback(() => setNonce(n => n + 1), []);

  return { wallet, isLoading, refresh };
}
