'use client';

import Script from 'next/script';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, Suspense } from 'react';
import type { MarketingPixels } from '@ebda/shared';
import { useFeatures } from '../contexts/FeatureContext';
import { useConsent } from '../contexts/ConsentContext';

import { REGION, isPersonalDataTerm } from '@ebda/shared';
import { urlCarriesPixelBlockedQuery } from '../lib/pixel-url-guard';
interface MarketingPixelsProps {
  pixels: MarketingPixels;
  /** The per-request CSP nonce (middleware.ts). Stamped on every pixel script: a browser without 'strict-dynamic' still honours it. */
  nonce?: string;
}

/**
 * Validate pixel ID format to prevent XSS
 * Only allows alphanumeric characters, hyphens, and underscores
 */
function isValidPixelId(id: string | undefined): id is string {
  if (!id) return false;
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

/**
 * Google Ads conversion target for `trackPurchase` (#1200). `trackPurchase`
 * is a bare function called from the checkout success page with no access to
 * store config, so the mounted pixel component publishes the validated
 * `AW-<id>/<label>` here. Null whenever Ads is off, the label is missing or
 * invalid, or consent / the feature is not granted.
 */
let googleAdsSendTo: string | null = null;

/**
 * Whether the mounted pixel component currently allows ANY pixel traffic (marketing consent +
 * feature on + a URL with nothing a pixel must not see). Every `track*` helper checks it first
 * (Ruling PIXEL-CONSENT-1): the provider scripts are also kept off the page without consent, but
 * a helper must not depend on that alone, so a library that is present for any other reason
 * (a merchant's GTM container, a stale tab) still receives nothing. Set during render, before
 * any child effect can call a helper; browser-only (the helpers return early on the server).
 */
let pixelEventsArmed = false;
function armPixelEvents(on: boolean) {
  if (typeof window !== 'undefined') pixelEventsArmed = on;
}

/**
 * Marketing Pixels Component
 *
 * Injects all configured marketing pixels into the page.
 * Uses Next.js Script component for safe script loading.
 */
function MarketingPixelsInner({ pixels, nonce }: MarketingPixelsProps) {
  const { isEnabled } = useFeatures();
  const { consent } = useConsent();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const featureEnabled = isEnabled('marketing_pixels');
  // Defense-in-depth: today the outer SSR gate in layout.tsx doesn't render
  // <MarketingPixelsProvider> at all without marketing consent. But if a
  // future refactor moves this component outside that SSR gate, the inner
  // `consent.marketing === true` check here prevents pixels from firing
  // anyway. Belt-and-braces for the most sensitive surface in the app.
  const marketingConsentGranted = consent?.marketing === true;
  // The pixels read the page URL themselves and send it to their network. A URL carrying a typed
  // term, an email, a phone or a one-time token (`?q=`, `?token=`, ...) therefore gets no pixel
  // at all: no library, no PageView, no event (Ruling PIXEL-CONSENT-1, launch blocker 32).
  const urlSafeForPixels = !urlCarriesPixelBlockedQuery(searchParams);
  const allowFire = featureEnabled && marketingConsentGranted && urlSafeForPixels;
  armPixelEvents(allowFire);

  // Track page views on route change. The hook MUST be unconditional —
  // moving the early-return above this useEffect violates rules-of-hooks.
  // Instead we gate the body on `allowFire` so it no-ops when either the
  // feature or marketing consent is off, and short-circuit the render
  // below the hook.
  useEffect(() => {
    if (!allowFire) return;
    if (typeof window === 'undefined') return;

    // Meta Pixel PageView
    if (pixels.meta?.enabled && 'fbq' in window) {
      (window as { fbq: (...args: string[]) => void }).fbq('track', 'PageView');
    }

    // TikTok Pixel PageView
    if (pixels.tiktok?.enabled && 'ttq' in window) {
      (window as { ttq: { page: () => void } }).ttq.page();
    }

    // Snapchat Pixel PageView
    if (pixels.snapchat?.enabled && 'snaptr' in window) {
      (window as { snaptr: (...args: string[]) => void }).snaptr('track', 'PAGE_VIEW');
    }

    // Twitter Pixel PageView
    if (pixels.twitter?.enabled && 'twq' in window) {
      (window as { twq: (...args: string[]) => void }).twq('track', 'PageView');
    }

    // Pinterest Tag PageView
    if (pixels.pinterest?.enabled && 'pintrk' in window) {
      (window as { pintrk: (...args: string[]) => void }).pintrk('page');
    }
  }, [pathname, searchParams, pixels, allowFire]);

  useEffect(() => () => armPixelEvents(false), []);

  const adsConversionId = pixels.googleAds?.conversionId;
  const adsConversionLabel = pixels.googleAds?.conversionLabel;
  const adsEnabled = pixels.googleAds?.enabled === true;
  useEffect(() => {
    googleAdsSendTo =
      allowFire &&
      adsEnabled &&
      isValidPixelId(adsConversionId) &&
      isValidPixelId(adsConversionLabel)
        ? `${adsConversionId}/${adsConversionLabel}`
        : null;
    return () => {
      googleAdsSendTo = null;
    };
  }, [allowFire, adsEnabled, adsConversionId, adsConversionLabel]);

  if (!allowFire) return null;

  // Validate all pixel IDs before rendering
  const validMeta = pixels.meta?.enabled && isValidPixelId(pixels.meta.pixelId);
  const validTiktok = pixels.tiktok?.enabled && isValidPixelId(pixels.tiktok.pixelId);
  const validSnapchat = pixels.snapchat?.enabled && isValidPixelId(pixels.snapchat.pixelId);
  const validGA4 =
    pixels.googleAnalytics?.enabled && isValidPixelId(pixels.googleAnalytics.measurementId);
  const validGTM =
    pixels.googleTagManager?.enabled && isValidPixelId(pixels.googleTagManager.containerId);
  const validGoogleAds = pixels.googleAds?.enabled && isValidPixelId(pixels.googleAds.conversionId);
  const validTwitter = pixels.twitter?.enabled && isValidPixelId(pixels.twitter.pixelId);
  const validPinterest = pixels.pinterest?.enabled && isValidPixelId(pixels.pinterest.tagId);

  return (
    <>
      {/* Google Tag Manager */}
      {validGTM && (
        <Script
          nonce={nonce}
          id="gtm"
          src={`https://www.googletagmanager.com/gtm.js?id=${pixels.googleTagManager!.containerId}`}
          strategy="afterInteractive"
        />
      )}

      {/* Google Analytics 4 */}
      {validGA4 && (
        <>
          <Script
            nonce={nonce}
            id="ga4"
            src={`https://www.googletagmanager.com/gtag/js?id=${
              pixels.googleAnalytics!.measurementId
            }`}
            strategy="afterInteractive"
          />
          <Script nonce={nonce} id="ga4-config" strategy="afterInteractive">
            {`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${
              pixels.googleAnalytics!.measurementId
            }')`}
          </Script>
        </>
      )}

      {/* Google Ads */}
      {validGoogleAds && (
        <>
          {/* gtag.js loader. The config call below pushes into window.dataLayer,
              but NOTHING drains that queue unless the Google tag library is on
              the page — and the only loader was inside the GA4 block above. So
              a merchant running Google Ads WITHOUT GA4 had conversions silently
              never reported: gtag() existed, the config landed, no library ever
              shipped it. Emitted only when GA4 is off, because when GA4 is on
              its loader already provides the SAME library. GTM is NOT a
              substitute (#1203): gtm.js is a container runtime that only runs
              the tags configured inside the merchant's container — it neither
              defines window.gtag nor interprets a pushed gtag('config','AW-…').
              gtag.js and gtm.js share window.dataLayer and are supported side
              by side. */}
          {!validGA4 && (
            <Script
              nonce={nonce}
              id="gads-lib"
              src={`https://www.googletagmanager.com/gtag/js?id=${pixels.googleAds!.conversionId}`}
              strategy="afterInteractive"
            />
          )}
          <Script nonce={nonce} id="gads-config" strategy="afterInteractive">
            {/* gtag('js', …) is part of Google's documented Ads snippet (#1202);
                with GA4 off this block is the library's only bootstrap. A second
                'js' call when GA4 is also on is harmless. */}
            {`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${
              pixels.googleAds!.conversionId
            }')`}
          </Script>
        </>
      )}

      {/* Meta Pixel */}
      {validMeta && (
        <Script nonce={nonce} id="meta-pixel" strategy="afterInteractive">
          {`!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${
            pixels.meta!.pixelId
          }');fbq('track','PageView')`}
        </Script>
      )}

      {/* TikTok Pixel */}
      {validTiktok && (
        <Script nonce={nonce} id="tiktok-pixel" strategy="afterInteractive">
          {`!function(w,d,t){w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie"],ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.instance=function(t){for(var e=ttq._i[t]||[],n=0;n<ttq.methods.length;n++)ttq.setAndDefer(e,ttq.methods[n]);return e},ttq.load=function(e,n){var i="https://analytics.tiktok.com/i18n/pixel/events.js";ttq._i=ttq._i||{},ttq._i[e]=[],ttq._i[e]._u=i,ttq._t=ttq._t||{},ttq._t[e]=+new Date,ttq._o=ttq._o||{},ttq._o[e]=n||{};var o=document.createElement("script");o.type="text/javascript",o.async=!0,o.src=i+"?sdkid="+e+"&lib="+t;var a=document.getElementsByTagName("script")[0];a.parentNode.insertBefore(o,a)};ttq.load('${
            pixels.tiktok!.pixelId
          }');ttq.page()}(window,document,'ttq')`}
        </Script>
      )}

      {/* Snapchat Pixel */}
      {validSnapchat && (
        <Script nonce={nonce} id="snapchat-pixel" strategy="afterInteractive">
          {`(function(e,t,n){if(e.snaptr)return;var a=e.snaptr=function(){a.handleRequest?a.handleRequest.apply(a,arguments):a.queue.push(arguments)};a.queue=[];var s='script';r=t.createElement(s);r.async=!0;r.src=n;var u=t.getElementsByTagName(s)[0];u.parentNode.insertBefore(r,u)})(window,document,'https://sc-static.net/scevent.min.js');snaptr('init','${
            pixels.snapchat!.pixelId
          }');snaptr('track','PAGE_VIEW')`}
        </Script>
      )}

      {/* Twitter Pixel */}
      {validTwitter && (
        <Script nonce={nonce} id="twitter-pixel" strategy="afterInteractive">
          {`!function(e,t,n,s,u,a){e.twq||(s=e.twq=function(){s.exe?s.exe.apply(s,arguments):s.queue.push(arguments)},s.version='1.1',s.queue=[],u=t.createElement(n),u.async=!0,u.src='https://static.ads-twitter.com/uwt.js',a=t.getElementsByTagName(n)[0],a.parentNode.insertBefore(u,a))}(window,document,'script');twq('config','${
            pixels.twitter!.pixelId
          }');twq('track','PageView')`}
        </Script>
      )}

      {/* Pinterest Tag */}
      {validPinterest && (
        <Script nonce={nonce} id="pinterest-tag" strategy="afterInteractive">
          {`!function(e){if(!window.pintrk){window.pintrk=function(){window.pintrk.queue.push(Array.prototype.slice.call(arguments))};var n=window.pintrk;n.queue=[],n.version="3.0";var t=document.createElement("script");t.async=!0,t.src=e;var r=document.getElementsByTagName("script")[0];r.parentNode.insertBefore(t,r)}}("https://s.pinimg.com/ct/core.js");pintrk('load','${
            pixels.pinterest!.tagId
          }');pintrk('page')`}
        </Script>
      )}
    </>
  );
}

/**
 * Wrapper component with Suspense for useSearchParams
 */
export function MarketingPixelsProvider({ pixels, nonce }: MarketingPixelsProps) {
  return (
    <Suspense fallback={null}>
      <MarketingPixelsInner pixels={pixels} nonce={nonce} />
    </Suspense>
  );
}

// ============================================
// E-commerce Event Tracking Utilities
// ============================================

type TrackingWindow = Window & {
  fbq?: (...args: unknown[]) => void;
  ttq?: { track: (event: string, params?: Record<string, unknown>) => void };
  snaptr?: (...args: unknown[]) => void;
  gtag?: (...args: unknown[]) => void;
  twq?: (...args: unknown[]) => void;
  pintrk?: (...args: unknown[]) => void;
};

/**
 * Track View Content event (product view)
 */
export function trackViewContent(params: {
  contentId: string;
  contentName: string;
  contentCategory?: string;
  value?: number;
  currency?: string;
}) {
  if (typeof window === 'undefined' || !pixelEventsArmed) return;
  const w = window as TrackingWindow;

  w.fbq?.('track', 'ViewContent', {
    content_ids: [params.contentId],
    content_name: params.contentName,
    content_category: params.contentCategory,
    value: params.value,
    currency: params.currency || REGION.currency,
  });

  w.ttq?.track('ViewContent', {
    content_id: params.contentId,
    content_name: params.contentName,
    value: params.value,
    currency: params.currency || REGION.currency,
  });

  w.snaptr?.('track', 'VIEW_CONTENT', {
    item_ids: [params.contentId],
    price: params.value,
    currency: params.currency || REGION.currency,
  });

  w.gtag?.('event', 'view_item', {
    items: [{ item_id: params.contentId, item_name: params.contentName, price: params.value }],
    currency: params.currency || REGION.currency,
    value: params.value,
  });

  w.twq?.('track', 'ViewContent');
  w.pintrk?.('track', 'pagevisit', { product_id: params.contentId });
}

/**
 * Track Add to Cart event
 */
export function trackAddToCart(params: {
  contentId: string;
  contentName: string;
  quantity?: number;
  value?: number;
  currency?: string;
}) {
  if (typeof window === 'undefined' || !pixelEventsArmed) return;
  const w = window as TrackingWindow;

  w.fbq?.('track', 'AddToCart', {
    content_ids: [params.contentId],
    content_name: params.contentName,
    value: params.value,
    currency: params.currency || REGION.currency,
  });

  w.ttq?.track('AddToCart', {
    content_id: params.contentId,
    quantity: params.quantity || 1,
    value: params.value,
    currency: params.currency || REGION.currency,
  });

  w.snaptr?.('track', 'ADD_CART', {
    item_ids: [params.contentId],
    price: params.value,
    currency: params.currency || REGION.currency,
  });

  w.gtag?.('event', 'add_to_cart', {
    items: [
      { item_id: params.contentId, item_name: params.contentName, quantity: params.quantity || 1 },
    ],
    currency: params.currency || REGION.currency,
    value: params.value,
  });

  w.twq?.('track', 'AddToCart');
  w.pintrk?.('track', 'addtocart', { product_id: params.contentId, value: params.value });
}

/**
 * Track Initiate Checkout event
 */
export function trackInitiateCheckout(params: {
  contentIds: string[];
  numItems: number;
  value: number;
  currency?: string;
}) {
  if (typeof window === 'undefined' || !pixelEventsArmed) return;
  const w = window as TrackingWindow;

  w.fbq?.('track', 'InitiateCheckout', {
    content_ids: params.contentIds,
    num_items: params.numItems,
    value: params.value,
    currency: params.currency || REGION.currency,
  });

  w.ttq?.track('InitiateCheckout', {
    content_ids: params.contentIds,
    value: params.value,
    currency: params.currency || REGION.currency,
  });

  w.snaptr?.('track', 'START_CHECKOUT', {
    item_ids: params.contentIds,
    price: params.value,
    number_items: params.numItems,
  });

  w.gtag?.('event', 'begin_checkout', {
    items: params.contentIds.map(id => ({ item_id: id })),
    currency: params.currency || REGION.currency,
    value: params.value,
  });

  w.twq?.('track', 'InitiateCheckout');
  w.pintrk?.('track', 'checkout', { value: params.value, order_quantity: params.numItems });
}

/**
 * Track Purchase/Conversion event
 *
 * DEDUPLICATION — eventID must equal the orderId passed here. The server-side
 * CAPI function (order-capi-conversion.ts) uses the same orderId as `event_id`
 * when posting to Meta and TikTok. Both platforms deduplicate on this pair so
 * only one conversion is counted even if both the browser pixel and the server
 * event arrive.
 *
 * Returns whether ANY pixel library was on the page to receive the event.
 * Every call below is optional-chained and silently no-ops when its global is
 * absent — which is the normal state before marketing consent, because the
 * root layout only renders the pixel provider once consent is granted. The
 * success page records "this order was reported" only on `true`, so a visit
 * with no pixels loaded (consent not yet given, blocked scripts) leaves the
 * order reportable on the next load. The Google Ads conversion needs `gtag`
 * too, so `googleAdsSendTo` alone never counts as a fire.
 */
export function trackPurchase(params: {
  orderId: string;
  contentIds: string[];
  numItems: number;
  value: number;
  currency?: string;
}): boolean {
  if (typeof window === 'undefined' || !pixelEventsArmed) return false;
  const w = window as TrackingWindow;
  const anyTrackerPresent = Boolean(w.fbq || w.ttq || w.snaptr || w.gtag || w.twq || w.pintrk);

  // eventID = orderId enables Meta CAPI deduplication (server event uses same id).
  w.fbq?.(
    'track',
    'Purchase',
    {
      content_ids: params.contentIds,
      num_items: params.numItems,
      value: params.value,
      currency: params.currency || REGION.currency,
    },
    {
      eventID: params.orderId,
    }
  );

  // event_id = orderId enables TikTok Events API deduplication.
  w.ttq?.track('CompletePayment', {
    content_ids: params.contentIds,
    value: params.value,
    currency: params.currency || REGION.currency,
    event_id: params.orderId,
  });

  w.snaptr?.('track', 'PURCHASE', {
    item_ids: params.contentIds,
    price: params.value,
    transaction_id: params.orderId,
  });

  w.gtag?.('event', 'purchase', {
    transaction_id: params.orderId,
    items: params.contentIds.map(id => ({ item_id: id })),
    currency: params.currency || REGION.currency,
    value: params.value,
  });

  // Google Ads attributes a conversion to a conversion ACTION only via an
  // explicit `conversion` event with `send_to: 'AW-<id>/<label>'` (#1200) —
  // the GA4 `purchase` event above is not an Ads conversion. transaction_id
  // lets Ads de-duplicate a repeat fire of the same order.
  if (googleAdsSendTo) {
    w.gtag?.('event', 'conversion', {
      send_to: googleAdsSendTo,
      value: params.value,
      currency: params.currency || REGION.currency,
      transaction_id: params.orderId,
    });
  }

  w.twq?.('track', 'Purchase', { value: params.value, num_items: params.numItems });
  w.pintrk?.('track', 'checkout', { value: params.value, order_id: params.orderId });

  return anyTrackerPresent;
}

/**
 * Track Search event.
 *
 * Ruling SEARCH-T5-9: the term goes to the merchant's ad networks (Meta, TikTok, Snap, Google,
 * Pinterest) only when it is NOT personal-data shaped (`isPersonalDataTerm`, the same gate the
 * first-party search log uses). A phone, email, order number, id or link typed into search still
 * fires the Search event, just without the term.
 */
export function trackSearch(params: { searchString: string }) {
  if (typeof window === 'undefined' || !pixelEventsArmed) return;
  const w = window as TrackingWindow;
  const term = isPersonalDataTerm(params.searchString) ? undefined : params.searchString;
  const withTerm = <K extends string>(key: K) =>
    term === undefined ? {} : ({ [key]: term } as Record<K, string>);

  w.fbq?.('track', 'Search', withTerm('search_string'));
  w.ttq?.track('Search', withTerm('query'));
  w.snaptr?.('track', 'SEARCH', withTerm('search_string'));
  w.gtag?.('event', 'search', withTerm('search_term'));
  w.twq?.('track', 'Search');
  w.pintrk?.('track', 'search', withTerm('search_query'));
}

/**
 * Track Add to Wishlist event
 */
export function trackAddToWishlist(params: {
  contentId: string;
  contentName: string;
  value?: number;
  currency?: string;
}) {
  if (typeof window === 'undefined' || !pixelEventsArmed) return;
  const w = window as TrackingWindow;

  w.fbq?.('track', 'AddToWishlist', {
    content_ids: [params.contentId],
    content_name: params.contentName,
    value: params.value,
    currency: params.currency || REGION.currency,
  });

  w.ttq?.track('AddToWishlist', {
    content_id: params.contentId,
    value: params.value,
    currency: params.currency || REGION.currency,
  });

  w.gtag?.('event', 'add_to_wishlist', {
    items: [{ item_id: params.contentId, item_name: params.contentName }],
    currency: params.currency || REGION.currency,
    value: params.value,
  });
}

/**
 * Track Lead/Contact event
 */
export function trackLead(params?: { contentName?: string; value?: number; currency?: string }) {
  if (typeof window === 'undefined' || !pixelEventsArmed) return;
  const w = window as TrackingWindow;

  w.fbq?.('track', 'Lead', { content_name: params?.contentName, value: params?.value });
  w.ttq?.track('SubmitForm', { content_name: params?.contentName });
  w.snaptr?.('track', 'SIGN_UP');
  w.gtag?.('event', 'generate_lead', {
    value: params?.value,
    currency: params?.currency || REGION.currency,
  });
  w.twq?.('track', 'Lead');
  w.pintrk?.('track', 'lead');
}
