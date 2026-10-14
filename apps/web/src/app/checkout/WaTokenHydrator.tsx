'use client';

/**
 * WA-token cart hydrator (Phase 6 / Option C, Ebda storefront).
 *
 * When the checkout URL carries ?waToken=<jwt>, redeem it via the
 * /api/v1/wa-bridge/cart/redeem endpoint to recover the cart payload
 * that WBS handed off. Hydrate the server cart via individual
 * api.addToCart calls, then refetchCart so the UI reflects the server
 * truth. Strips the token from the URL to prevent double-hydration on
 * refresh.
 *
 * Race condition fix (Issue 4): we wait for CartContext.isReady before
 * running so CartContext.hydrate() has already settled. This prevents
 * the hydrate() useEffect from overwriting our items with an empty cart.
 *
 * Idempotent: sessionStorage marker prevents re-running on HMR /
 * strict-mode double-mount.
 *
 * Bundle lines (Task 10): a token carrying `bundles` adds each one via
 * `api.addBundleToCart` — the exact client call `BundleDetailClient`/
 * `CartContext.addBundle` already use to reach `CartService.addBundle`, not
 * a new endpoint. Mirrors the product loop above it (direct API call, not
 * `useCart().addBundle`, so this hydration path stays toast-free by
 * default and only surfaces a failure). Unlike a product add's silent
 * `console.warn`, a bundle that sold out between token issue and
 * redemption gets a user-visible toast: the customer picked one specific
 * box, not a fungible SKU, so silently dropping it is more likely to
 * confuse them into paying for a box they never received. The copy is
 * `bundle-cart-errors.ts`'s existing `classifyBundleCartError`/
 * `bundleCartErrorCopy` — the SAME classifier `CartContext.addBundle`
 * already uses for this identical `/public/cart/bundles` 422 shape (a flat
 * `{ error: 'bundle_not_purchasable' | 'insufficient_stock' }` string, not
 * this app's usual `{code,message}` envelope) — reused rather than
 * reinventing copy.
 */

import { useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCart } from '../../contexts/CartContext';
import { useToast } from '@ebda/ui';
import { useLanguage } from '../../contexts/LanguageContext';
import { api } from '../../lib/api';
import { classifyBundleCartError, bundleCartErrorCopy } from '../../lib/bundle-cart-errors';
import {
  sessionGet,
  sessionSet,
  parseWaCartPayload,
  isRedeemableItem,
  hydrateBundles,
  urlWithoutToken,
} from './wa-token';

const SESSION_KEY = 'ebda.wa-cart-redeemed';

export default function WaTokenHydrator() {
  const router = useRouter();
  const params = useSearchParams();
  const { isReady, refetchCart } = useCart();
  const toast = useToast();
  const { t } = useLanguage();
  const ranRef = useRef(false);

  useEffect(() => {
    // Issue 4: wait until CartContext.hydrate() has settled so we don't race
    // with its setItems(serverItems) call overwriting our additions.
    if (!isReady) return;
    if (ranRef.current) return;
    const token = params.get('waToken');
    if (!token) return;

    // sessionStorage marker — survives HMR + strict-mode double-mount.
    if (sessionGet(SESSION_KEY) === token) return;
    ranRef.current = true;
    sessionSet(SESSION_KEY, token);

    (async () => {
      try {
        // Through the ApiClient, not a raw fetch: it attaches X-Session-ID and
        // X-CSRF-Token. /wa-bridge is mounted before csrfProtection in
        // apps/api/src/index.ts so redeem does not reach the verifier today,
        // but merchant custom origins are no longer CSRF-exempt — a raw fetch
        // here would 403 the moment that mount order changed, and the catch
        // below only console.warns, so the cart would silently arrive empty.
        const res = await api.post<{
          items?: unknown[];
          bundles?: unknown[];
          customerPhone?: string;
        }>('/wa-bridge/cart/redeem', { token });
        if (!res.success) {
          // eslint-disable-next-line no-console
          console.warn('[wa-token-hydrator] redeem failed', res.error);
          return;
        }
        const data = parseWaCartPayload(res);
        if (!data) return;

        // Issue 4: call api.addToCart directly (bypassing the addItem
        // optimistic update + toast) and refetch once at the end so the UI
        // reflects the server-authoritative cart state. Sequential to preserve
        // order and avoid duplicate-detection races.
        let anyAdded = false;
        for (const item of data.items) {
          if (!isRedeemableItem(item)) continue;
          const addRes = await api.addToCart(item.productId as string, item.quantity as number);
          if (addRes.success) {
            anyAdded = true;
          } else {
            // eslint-disable-next-line no-console
            console.warn('[wa-token-hydrator] addToCart failed for', item.productId, addRes.error);
          }
        }

        // Bundle lines (Task 10) — same client call BundleDetailClient uses
        // (api.addBundleToCart -> POST /public/cart/bundles ->
        // CartService.addBundle), one call per entry. A failure here (the
        // box sold out between token issue and redemption) gets a
        // user-visible toast, unlike the silent console.warn above — see
        // the file doc comment for why.
        const bundleAdded = await hydrateBundles(
          data.bundles ?? [],
          (bundleId, quantity) => api.addBundleToCart(bundleId, quantity),
          (bundleId, error) => {
            // eslint-disable-next-line no-console
            console.warn('[wa-token-hydrator] addBundleToCart failed for', bundleId, error);
            const { title, message } = bundleCartErrorCopy(classifyBundleCartError(error), t);
            toast.error(title, message);
          }
        );
        if (bundleAdded) anyAdded = true;

        if (anyAdded) {
          // Refetch to get the authoritative server cart state (prices,
          // stock status, slugs) rather than relying on the JWT snapshot.
          await refetchCart().catch(() => {});
        }

        // Stash customer phone for the shipping-step pre-fill.
        if (data.customerPhone) {
          sessionSet('ebda.wa-customer-phone', data.customerPhone);
        }

        // Strip the token from the URL so a refresh doesn't re-redeem.
        router.replace(urlWithoutToken(window.location.href), { scroll: false });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[wa-token-hydrator] failed', (err as Error).message);
      }
    })();
  }, [isReady, params, refetchCart, router, toast, t]);

  return null;
}
