'use client';

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';

/**
 * Cookie consent for marketing/tracking pixels. Single category at v1 —
 * "marketing" covers all 7 pixel types (Meta, GA4, Google Ads, TikTok,
 * Snapchat, Twitter, Pinterest). Essential cookies (language, cart, auth)
 * are always on and not configurable.
 *
 * Persisted in `force-cookie-consent` cookie so the server (layout.tsx
 * via next/headers `cookies()`) can decide whether to RENDER the pixel
 * scripts at all. Without consent, the scripts never reach the
 * browser — server-side gating is the only way to comply fully with
 * GDPR ePrivacy and applicable GCC data-protection law (see
 * docs/privacy/data-map.md).
 */

export type ConsentState = {
  marketing: boolean;
  v: 1;
  ts: string; // ISO timestamp of the decision
};

interface ConsentContextType {
  /** Resolved consent. `null` = user hasn't decided yet (show banner). */
  consent: ConsentState | null;
  /** True after the user has clicked any of Accept / Reject / Save. */
  hasDecided: boolean;
  /** Set consent (writes cookie + reloads so server-side gating applies). */
  setConsent: (next: { marketing: boolean }) => void;
  /** Trigger the preferences modal — used by the footer "Cookie preferences" link. */
  openPreferences: () => void;
  /** Whether the modal is currently open. Read by CookiePreferencesModal. */
  isPreferencesOpen: boolean;
  /** Close the modal. */
  closePreferences: () => void;
}

const ConsentContext = createContext<ConsentContextType | undefined>(undefined);

const COOKIE_NAME = 'force-cookie-consent';

function readCookieClient(): ConsentState | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp('(^|; )' + COOKIE_NAME + '=([^;]*)'));
  if (!match) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(match[2])) as ConsentState;
    if (parsed && typeof parsed.marketing === 'boolean' && parsed.v === 1) return parsed;
    return null;
  } catch {
    return null;
  }
}

function writeCookie(value: ConsentState): void {
  if (typeof document === 'undefined') return;
  // 1 year, path=/, SameSite=Lax so it persists across navigation +
  // store-domain redirects and is included on first-party reads.
  // Secure only on https (Safari treats localhost as untrustworthy for
  // Secure cookies). ZAP 10011.
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie =
    `${COOKIE_NAME}=${encodeURIComponent(JSON.stringify(value))}; ` +
    `path=/; max-age=31536000; SameSite=Lax${secure}`;
}

interface ConsentProviderProps {
  children: ReactNode;
  /** Resolved consent from the server-side cookie read in layout.tsx.
   *  Passed in so client + server agree on first render (no hydration mismatch). */
  initialConsent: ConsentState | null;
}

export function ConsentProvider({ children, initialConsent }: ConsentProviderProps) {
  const [consent, setConsentState] = useState<ConsentState | null>(initialConsent);
  const [isPreferencesOpen, setPreferencesOpen] = useState(false);

  // On mount, re-sync from document.cookie in case the server didn't have
  // access (e.g. ISR-cached page). Server value wins for hydration; this
  // catches the edge case where the cookie exists but server didn't read it.
  useEffect(() => {
    if (consent === null) {
      const fromCookie = readCookieClient();
      if (fromCookie) setConsentState(fromCookie);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setConsent = ({ marketing }: { marketing: boolean }) => {
    const next: ConsentState = {
      marketing,
      v: 1,
      ts: new Date().toISOString(),
    };
    const previouslyMarketing = consent?.marketing === true;
    setConsentState(next);
    writeCookie(next);
    setPreferencesOpen(false);
    // Reload only when the server-side pixel gating in layout.tsx must change: marketing
    // turned ON (pixels must now render) or OFF after having been on (rendered pixels must
    // go). A first-time reject changes nothing on the server (no pixel was rendered), so it
    // must not reload the page (QA-C2). Defer one tick so the cookie write commits.
    if (typeof window !== 'undefined' && next.marketing !== previouslyMarketing) {
      setTimeout(() => window.location.reload(), 0);
    }
  };

  const openPreferences = () => setPreferencesOpen(true);
  const closePreferences = () => setPreferencesOpen(false);

  return (
    <ConsentContext.Provider
      value={{
        consent,
        hasDecided: consent !== null,
        setConsent,
        openPreferences,
        isPreferencesOpen,
        closePreferences,
      }}
    >
      {children}
    </ConsentContext.Provider>
  );
}

export function useConsent(): ConsentContextType {
  const ctx = useContext(ConsentContext);
  if (!ctx) throw new Error('useConsent must be used within a ConsentProvider');
  return ctx;
}
