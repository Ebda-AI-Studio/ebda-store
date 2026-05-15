'use client';

import Script from 'next/script';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, Suspense } from 'react';
import type { MarketingPixels } from '@force/shared';
import { useFeatures } from '../contexts/FeatureContext';
import { useConsent } from '../contexts/ConsentContext';

interface MarketingPixelsProps {
  pixels: MarketingPixels;
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
 * Marketing Pixels Component
 *
 * Injects all configured marketing pixels into the page.
 * Uses Next.js Script component for safe script loading.
 */
function MarketingPixelsInner({ pixels }: MarketingPixelsProps) {
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
  const allowFire = featureEnabled && marketingConsentGranted;

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
          id="gtm"
          src={`https://www.googletagmanager.com/gtm.js?id=${pixels.googleTagManager!.containerId}`}
          strategy="afterInteractive"
        />
      )}

      {/* Google Analytics 4 */}
      {validGA4 && (
        <>
          <Script
            id="ga4"
            src={`https://www.googletagmanager.com/gtag/js?id=${pixels.googleAnalytics!.measurementId}`}
            strategy="afterInteractive"
          />
          <Script id="ga4-config" strategy="afterInteractive">
            {`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${pixels.googleAnalytics!.measurementId}')`}
          </Script>
        </>
      )}

      {/* Google Ads */}
      {validGoogleAds && (
        <Script id="gads-config" strategy="afterInteractive">
          {`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('config','${pixels.googleAds!.conversionId}')`}
        </Script>
      )}

      {/* Meta Pixel */}
      {validMeta && (
        <Script id="meta-pixel" strategy="afterInteractive">
          {`!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${pixels.meta!.pixelId}');fbq('track','PageView')`}
        </Script>
      )}

      {/* TikTok Pixel */}
      {validTiktok && (
        <Script id="tiktok-pixel" strategy="afterInteractive">
          {`!function(w,d,t){w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie"],ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.instance=function(t){for(var e=ttq._i[t]||[],n=0;n<ttq.methods.length;n++)ttq.setAndDefer(e,ttq.methods[n]);return e},ttq.load=function(e,n){var i="https://analytics.tiktok.com/i18n/pixel/events.js";ttq._i=ttq._i||{},ttq._i[e]=[],ttq._i[e]._u=i,ttq._t=ttq._t||{},ttq._t[e]=+new Date,ttq._o=ttq._o||{},ttq._o[e]=n||{};var o=document.createElement("script");o.type="text/javascript",o.async=!0,o.src=i+"?sdkid="+e+"&lib="+t;var a=document.getElementsByTagName("script")[0];a.parentNode.insertBefore(o,a)};ttq.load('${pixels.tiktok!.pixelId}');ttq.page()}(window,document,'ttq')`}
        </Script>
      )}

      {/* Snapchat Pixel */}
      {validSnapchat && (
        <Script id="snapchat-pixel" strategy="afterInteractive">
          {`(function(e,t,n){if(e.snaptr)return;var a=e.snaptr=function(){a.handleRequest?a.handleRequest.apply(a,arguments):a.queue.push(arguments)};a.queue=[];var s='script';r=t.createElement(s);r.async=!0;r.src=n;var u=t.getElementsByTagName(s)[0];u.parentNode.insertBefore(r,u)})(window,document,'https://sc-static.net/scevent.min.js');snaptr('init','${pixels.snapchat!.pixelId}');snaptr('track','PAGE_VIEW')`}
        </Script>
      )}

      {/* Twitter Pixel */}
      {validTwitter && (
        <Script id="twitter-pixel" strategy="afterInteractive">
          {`!function(e,t,n,s,u,a){e.twq||(s=e.twq=function(){s.exe?s.exe.apply(s,arguments):s.queue.push(arguments)},s.version='1.1',s.queue=[],u=t.createElement(n),u.async=!0,u.src='https://static.ads-twitter.com/uwt.js',a=t.getElementsByTagName(n)[0],a.parentNode.insertBefore(u,a))}(window,document,'script');twq('config','${pixels.twitter!.pixelId}');twq('track','PageView')`}
        </Script>
      )}

      {/* Pinterest Tag */}
      {validPinterest && (
        <Script id="pinterest-tag" strategy="afterInteractive">
          {`!function(e){if(!window.pintrk){window.pintrk=function(){window.pintrk.queue.push(Array.prototype.slice.call(arguments))};var n=window.pintrk;n.queue=[],n.version="3.0";var t=document.createElement("script");t.async=!0,t.src=e;var r=document.getElementsByTagName("script")[0];r.parentNode.insertBefore(t,r)}}("https://s.pinimg.com/ct/core.js");pintrk('load','${pixels.pinterest!.tagId}');pintrk('page')`}
        </Script>
      )}
    </>
  );
}

/**
 * Wrapper component with Suspense for useSearchParams
 */
export function MarketingPixelsProvider({ pixels }: MarketingPixelsProps) {
  return (
    <Suspense fallback={null}>
      <MarketingPixelsInner pixels={pixels} />
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
  if (typeof window === 'undefined') return;
  const w = window as TrackingWindow;

  w.fbq?.('track', 'ViewContent', {
    content_ids: [params.contentId],
    content_name: params.contentName,
    content_category: params.contentCategory,
    value: params.value,
    currency: params.currency || 'KWD',
  });

  w.ttq?.track('ViewContent', {
    content_id: params.contentId,
    content_name: params.contentName,
    value: params.value,
    currency: params.currency || 'KWD',
  });

  w.snaptr?.('track', 'VIEW_CONTENT', {
    item_ids: [params.contentId],
    price: params.value,
    currency: params.currency || 'KWD',
  });

  w.gtag?.('event', 'view_item', {
    items: [{ item_id: params.contentId, item_name: params.contentName, price: params.value }],
    currency: params.currency || 'KWD',
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
  if (typeof window === 'undefined') return;
  const w = window as TrackingWindow;

  w.fbq?.('track', 'AddToCart', {
    content_ids: [params.contentId],
    content_name: params.contentName,
    value: params.value,
    currency: params.currency || 'KWD',
  });

  w.ttq?.track('AddToCart', {
    content_id: params.contentId,
    quantity: params.quantity || 1,
    value: params.value,
    currency: params.currency || 'KWD',
  });

  w.snaptr?.('track', 'ADD_CART', {
    item_ids: [params.contentId],
    price: params.value,
    currency: params.currency || 'KWD',
  });

  w.gtag?.('event', 'add_to_cart', {
    items: [
      { item_id: params.contentId, item_name: params.contentName, quantity: params.quantity || 1 },
    ],
    currency: params.currency || 'KWD',
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
  if (typeof window === 'undefined') return;
  const w = window as TrackingWindow;

  w.fbq?.('track', 'InitiateCheckout', {
    content_ids: params.contentIds,
    num_items: params.numItems,
    value: params.value,
    currency: params.currency || 'KWD',
  });

  w.ttq?.track('InitiateCheckout', {
    content_ids: params.contentIds,
    value: params.value,
    currency: params.currency || 'KWD',
  });

  w.snaptr?.('track', 'START_CHECKOUT', {
    item_ids: params.contentIds,
    price: params.value,
    number_items: params.numItems,
  });

  w.gtag?.('event', 'begin_checkout', {
    items: params.contentIds.map(id => ({ item_id: id })),
    currency: params.currency || 'KWD',
    value: params.value,
  });

  w.twq?.('track', 'InitiateCheckout');
  w.pintrk?.('track', 'checkout', { value: params.value, order_quantity: params.numItems });
}

/**
 * Track Purchase/Conversion event
 */
export function trackPurchase(params: {
  orderId: string;
  contentIds: string[];
  numItems: number;
  value: number;
  currency?: string;
}) {
  if (typeof window === 'undefined') return;
  const w = window as TrackingWindow;

  w.fbq?.('track', 'Purchase', {
    content_ids: params.contentIds,
    num_items: params.numItems,
    value: params.value,
    currency: params.currency || 'KWD',
  });

  w.ttq?.track('CompletePayment', {
    content_ids: params.contentIds,
    value: params.value,
    currency: params.currency || 'KWD',
  });

  w.snaptr?.('track', 'PURCHASE', {
    item_ids: params.contentIds,
    price: params.value,
    transaction_id: params.orderId,
  });

  w.gtag?.('event', 'purchase', {
    transaction_id: params.orderId,
    items: params.contentIds.map(id => ({ item_id: id })),
    currency: params.currency || 'KWD',
    value: params.value,
  });

  w.twq?.('track', 'Purchase', { value: params.value, num_items: params.numItems });
  w.pintrk?.('track', 'checkout', { value: params.value, order_id: params.orderId });
}

/**
 * Track Search event
 */
export function trackSearch(params: { searchString: string }) {
  if (typeof window === 'undefined') return;
  const w = window as TrackingWindow;

  w.fbq?.('track', 'Search', { search_string: params.searchString });
  w.ttq?.track('Search', { query: params.searchString });
  w.snaptr?.('track', 'SEARCH', { search_string: params.searchString });
  w.gtag?.('event', 'search', { search_term: params.searchString });
  w.twq?.('track', 'Search');
  w.pintrk?.('track', 'search', { search_query: params.searchString });
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
  if (typeof window === 'undefined') return;
  const w = window as TrackingWindow;

  w.fbq?.('track', 'AddToWishlist', {
    content_ids: [params.contentId],
    content_name: params.contentName,
    value: params.value,
    currency: params.currency || 'KWD',
  });

  w.ttq?.track('AddToWishlist', {
    content_id: params.contentId,
    value: params.value,
    currency: params.currency || 'KWD',
  });

  w.gtag?.('event', 'add_to_wishlist', {
    items: [{ item_id: params.contentId, item_name: params.contentName }],
    currency: params.currency || 'KWD',
    value: params.value,
  });
}

/**
 * Track Lead/Contact event
 */
export function trackLead(params?: { contentName?: string; value?: number; currency?: string }) {
  if (typeof window === 'undefined') return;
  const w = window as TrackingWindow;

  w.fbq?.('track', 'Lead', { content_name: params?.contentName, value: params?.value });
  w.ttq?.track('SubmitForm', { content_name: params?.contentName });
  w.snaptr?.('track', 'SIGN_UP');
  w.gtag?.('event', 'generate_lead', { value: params?.value, currency: params?.currency || 'KWD' });
  w.twq?.('track', 'Lead');
  w.pintrk?.('track', 'lead');
}
