/// <reference lib="dom" />
/* eslint-disable @typescript-eslint/no-explicit-any -- third-party globals (fbq, posthog) have no types here */
/**
 * Browser runtime for Ebda's own acquisition tracking (marketing site + store.ebda.app signup).
 * Framework-free so the static marketing export and the Next admin share one implementation.
 *
 * The rule it enforces: NOTHING loads or fires before the visitor consented.
 *   - no consent decision yet  -> no script, no cookie besides the consent cookie itself;
 *                                 events are held in memory (max 20) for the banner answer
 *   - declined                 -> nothing, held events dropped
 *   - analytics allowed        -> PostHog (named instance `ebda`, shared across *.ebda.app)
 *   - marketing allowed        -> Meta Pixel + first-touch attribution cookie
 * No pixel id / PostHog key configured -> that provider never loads, no error.
 */
import { CONSENT_UI } from './consent-ui';
import { BRAND } from '../brand';
import {
  EBDA_CONSENT_COOKIE,
  EBDA_CONSENT_EVENT,
  EBDA_CONSENT_MAX_AGE_DAYS,
  hasAnyConsent,
  parseConsent,
  serializeConsent,
  type EbdaConsent,
} from './consent';
import {
  EBDA_ATTRIBUTION_COOKIE,
  EBDA_ATTRIBUTION_MAX_AGE_DAYS,
  META_FBC_COOKIE,
  META_FBP_COOKIE,
  captureAttribution,
  parseAttribution,
  serializeAttribution,
} from './attribution';
import { EBDA_FUNNEL, type FunnelStep, type SignupTracking } from './funnel';
// Relative (not the barrel): this subpath stays a small, pure browser module.
import { scrubPostHogCapture, urlCarriesSensitiveQuery } from '../utils/sentry-url-scrub';

export interface TrackerConfig {
  /** Public Meta Pixel id (NEXT_PUBLIC_EBDA_META_PIXEL_ID). Empty -> Meta never loads. */
  metaPixelId?: string;
  /** Public PostHog project key (NEXT_PUBLIC_POSTHOG_KEY). Empty -> PostHog never loads. */
  posthogKey?: string;
  /** PostHog ingest host, default EU cloud. */
  posthogHost?: string;
  /** Where the banner links for details. */
  privacyUrl?: string;
}

export interface TrackOptions {
  /** Meta dedup id; pass the SAME id the server sends for the matching Conversions API event. */
  eventId?: string;
  props?: Record<string, unknown>;
}

export interface Tracker {
  /** Current consent, or null when the visitor has not decided. */
  consent(): EbdaConsent | null;
  /** Read consent and load whatever it allows. Safe to call more than once. */
  start(): void;
  /** Record a banner answer: writes the cookie, loads providers, replays held events. */
  setConsent(c: { analytics: boolean; marketing: boolean }): void;
  track(step: FunnelStep, opts?: TrackOptions): void;
  pageView(): void;
  /** Attribution + click ids for the signup request; undefined when nothing may be sent. */
  signupPayload(): SignupTracking | undefined;
  /** Show the Arabic/English consent banner (no-op once decided unless `force`). */
  showBanner(force?: boolean): void;
}

const META_SRC = 'https://connect.facebook.net/en_US/fbevents.js';
const PH_INSTANCE = 'ebda';
const MAX_HELD = 20;

interface Held {
  step: FunnelStep;
  opts?: TrackOptions;
}

function cookieDomain(host: string): string {
  const root = BRAND.domains.marketing;
  return host === root || host.endsWith(`.${root}`) ? `; domain=.${root}` : '';
}

export function readCookie(doc: Document, name: string): string | null {
  const m = doc.cookie.match(new RegExp(`(?:^|; )${name.replace(/[^\w-]/g, '')}=([^;]*)`));
  return m ? m[1] : null;
}

function writeCookie(win: Window, name: string, value: string, days: number): void {
  const secure = win.location.protocol === 'https:' ? '; Secure' : '';
  win.document.cookie = `${name}=${value}; path=/; max-age=${days * 86400}; SameSite=Lax${cookieDomain(win.location.hostname)}${secure}`;
}

/** `https://eu.i.posthog.com` -> `https://eu-assets.i.posthog.com` (where array.js lives). */
export function posthogAssetsHost(apiHost: string): string {
  return apiHost.replace('.i.posthog.com', '-assets.i.posthog.com');
}

const COPY = CONSENT_UI;

export function createTracker(config: TrackerConfig, win: Window): Tracker {
  const doc = win.document;
  const w = win as any;
  let metaLoaded = false;
  let phStarted = false;
  let phInstance: any = null;
  const phQueue: Array<[string, Record<string, unknown> | undefined]> = [];
  const held: Held[] = [];

  const readConsent = () => parseConsent(readCookie(doc, EBDA_CONSENT_COOKIE));

  function captureNow(): void {
    const next = captureAttribution({
      search: win.location.search,
      pathname: win.location.pathname,
      referrer: doc.referrer,
      now: Date.now(),
      existing: parseAttribution(readCookie(doc, EBDA_ATTRIBUTION_COOKIE)),
    });
    if (next) {
      writeCookie(
        win,
        EBDA_ATTRIBUTION_COOKIE,
        serializeAttribution(next),
        EBDA_ATTRIBUTION_MAX_AGE_DAYS
      );
      // Meta's own cookie, so the pixel and the server event agree on the click.
      if (next.fbc) writeCookie(win, META_FBC_COOKIE, next.fbc, EBDA_ATTRIBUTION_MAX_AGE_DAYS);
    }
  }

  /**
   * The Meta pixel reads the page URL itself and sends it to Meta, so it neither loads nor fires
   * on a URL carrying a typed term, an email, a phone or a one-time token (`/verify-email?token=`,
   * Ruling PIXEL-CONSENT-1). The server-side Conversions API event for the same step still goes.
   */
  const urlBlockedForPixel = () => urlCarriesSensitiveQuery(win.location.search);

  function loadMeta(): void {
    if (metaLoaded || !config.metaPixelId || urlBlockedForPixel()) return;
    metaLoaded = true;
    if (!w.fbq) {
      const n: any = function (...args: unknown[]) {
        if (n.callMethod) n.callMethod(...args);
        else n.queue.push(args);
      };
      w.fbq = n;
      if (!w._fbq) w._fbq = n;
      n.push = n;
      n.loaded = true;
      n.version = '2.0';
      n.queue = [];
      const s = doc.createElement('script');
      s.async = true;
      s.src = META_SRC;
      doc.head.appendChild(s);
    }
    w.fbq('init', config.metaPixelId);
  }

  function flushPh(): void {
    if (!phInstance) return;
    while (phQueue.length) {
      const [name, props] = phQueue.shift()!;
      phInstance.capture(name, props);
    }
  }

  function loadPostHog(): void {
    if (phStarted || !config.posthogKey) return;
    phStarted = true;
    const host = config.posthogHost || 'https://eu.i.posthog.com';
    const s = doc.createElement('script');
    s.async = true;
    s.src = `${posthogAssetsHost(host)}/static/array.js`;
    s.onload = () => {
      try {
        phInstance = w.posthog.init(
          config.posthogKey,
          {
            api_host: host,
            ip: false,
            // Funnel stitching across ebda.app -> store.ebda.app.
            cross_subdomain_cookie: true,
            persistence: 'localStorage+cookie',
            capture_pageview: 'history_change',
            disable_session_recording: true,
            respect_dnt: true,
            // Free-text query values (?q=, ?search=, ?email=, ?phone=) never leave in a capture.
            before_send: scrubPostHogCapture,
          },
          PH_INSTANCE
        );
        flushPh();
      } catch {
        phQueue.length = 0;
      }
    };
    s.onerror = () => {
      phQueue.length = 0;
    };
    doc.head.appendChild(s);
  }

  function fire(step: FunnelStep, opts: TrackOptions | undefined, c: EbdaConsent): void {
    const def = EBDA_FUNNEL[step];
    if (c.marketing && config.metaPixelId && w.fbq && !urlBlockedForPixel()) {
      w.fbq(
        def.metaCustom ? 'trackCustom' : 'track',
        def.meta,
        opts?.props ?? {},
        opts?.eventId ? { eventID: opts.eventId } : undefined
      );
    }
    // The $pageview is posthog's own (history_change); do not double count it.
    if (c.analytics && config.posthogKey && step !== 'page_view') {
      const props = {
        ...(opts?.props ?? {}),
        ...(opts?.eventId ? { event_id: opts.eventId } : {}),
      };
      if (phInstance) phInstance.capture(def.posthog, props);
      else if (phStarted) phQueue.push([def.posthog, props]);
    }
  }

  function start(): void {
    const c = readConsent();
    if (!hasAnyConsent(c)) return;
    if (c!.marketing || c!.analytics) captureNow();
    if (c!.marketing) loadMeta();
    if (c!.analytics) loadPostHog();
  }

  function track(step: FunnelStep, opts?: TrackOptions): void {
    const c = readConsent();
    if (!c) {
      // Undecided: keep it for the banner answer; never send.
      if (held.length < MAX_HELD) held.push({ step, opts });
      return;
    }
    if (!hasAnyConsent(c)) return;
    start();
    fire(step, opts, c);
  }

  function setConsent(choice: { analytics: boolean; marketing: boolean }): void {
    writeCookie(win, EBDA_CONSENT_COOKIE, serializeConsent(choice), EBDA_CONSENT_MAX_AGE_DAYS);
    try {
      win.dispatchEvent(new CustomEvent(EBDA_CONSENT_EVENT));
    } catch {
      // no CustomEvent (very old browser): listeners re-read the cookie on their next mount
    }
    const c = readConsent();
    const replay = held.splice(0);
    if (!hasAnyConsent(c)) return;
    start();
    for (const h of replay) fire(h.step, h.opts, c!);
  }

  function showBanner(force = false): void {
    if (!force && readConsent()) return;
    if (doc.getElementById('ebda-consent')) return;
    const lang = doc.documentElement.lang === 'en' ? 'en' : 'ar';
    const t = COPY[lang];
    const bar = doc.createElement('div');
    bar.id = 'ebda-consent';
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-label', t.label);
    bar.dir = lang === 'ar' ? 'rtl' : 'ltr';
    // COOKIE-UI-1: the same bar as the store (words and order from consent-ui.ts). On a phone it is one compact
    // bar (<= 12% of the viewport): a short sentence with the Customize link, then Reject and Accept as equals.
    const compact =
      typeof win.matchMedia === 'function' && win.matchMedia('(max-width:600px)').matches;
    bar.style.cssText =
      `position:fixed;inset-inline:${compact ? 8 : 16}px;bottom:${compact ? 8 : 16}px;z-index:2147483000;max-width:640px;margin-inline:auto;` +
      `background:${BRAND.colors.night};color:#fff;border:1px solid rgba(255,255,255,.18);border-radius:12px;` +
      `padding:${compact ? '8px 12px' : '16px'};font:${compact ? '12px/1.5' : '14px/1.6'} ${BRAND.fonts.stacks.arabic};box-shadow:0 8px 32px rgba(0,0,0,.4)`;
    const linkCss = `color:${BRAND.colors.gold};text-decoration:underline;text-underline-offset:3px;background:none;border:0;padding:0;font:inherit;cursor:pointer`;
    const p = doc.createElement('p');
    p.style.margin = compact ? '0 0 6px' : '0 0 12px';
    p.textContent = `${t.text} `;
    if (config.privacyUrl) {
      const a = doc.createElement('a');
      a.href = config.privacyUrl;
      a.textContent = t.more;
      a.style.cssText = linkCss;
      p.appendChild(a);
      p.append(' · ');
    }
    const custom = doc.createElement('button');
    custom.type = 'button';
    custom.textContent = t.customize;
    custom.style.cssText = linkCss;
    p.appendChild(custom);
    const row = doc.createElement('div');
    row.style.cssText = compact ? 'display:flex;gap:8px' : 'display:flex;gap:8px;flex-wrap:wrap';
    // The bar is fixed over the page, so page chrome that reaches the bottom of the screen (the
    // phone menu panel) has to stop above it. Publish the bar's height on the root element as
    // `--ebda-consent-h` (px) while it is shown, and take it away with the bar. The name and the
    // unit are read by the sites' stylesheets: change them together.
    const root = doc.documentElement;
    const publishHeight = () => {
      const h = Math.ceil(bar.getBoundingClientRect().height);
      root.style.setProperty('--ebda-consent-h', `${h}px`);
    };
    // Keeps the value true when the bar wraps differently (rotation, a font arriving late).
    const Observer = (win as Window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    const sizeWatch = typeof Observer === 'function' ? new Observer(publishHeight) : null;
    const answer = (analytics: boolean, marketing: boolean) => {
      setConsent({ analytics, marketing });
      bar.remove();
      sizeWatch?.disconnect();
      root.style.removeProperty('--ebda-consent-h');
    };
    // Reject and Accept are the SAME control: same size, same fill, one tap each.
    const btnCss = `min-height:44px;padding:0 ${compact ? 10 : 18}px;border-radius:8px;font:inherit;font-weight:600;cursor:pointer;${compact ? 'flex:1;' : ''}background:#efe9dd;color:${BRAND.colors.night};border:0`;
    const mk = (label: string, choice: boolean) => {
      const b = doc.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.style.cssText = btnCss;
      b.addEventListener('click', () => answer(choice, choice));
      return b;
    };
    row.append(mk(t.reject, false), mk(t.accept, true));
    // Customize swaps the two buttons for one choice per purpose and a save button.
    custom.addEventListener('click', () => {
      const box = (label: string) => {
        const l = doc.createElement('label');
        l.style.cssText = 'display:flex;align-items:center;gap:8px;min-height:44px;flex:1 0 100%';
        const i = doc.createElement('input');
        i.type = 'checkbox';
        i.style.cssText = 'width:20px;height:20px;accent-color:' + BRAND.colors.gold;
        l.append(i, label);
        return { l, i };
      };
      const an = box(t.analytics);
      const mkt = box(t.marketing);
      const save = doc.createElement('button');
      save.type = 'button';
      save.textContent = t.save;
      save.style.cssText = btnCss + ';flex:1 0 100%';
      save.addEventListener('click', () => answer(an.i.checked, mkt.i.checked));
      row.replaceChildren(an.l, mkt.l, save);
      custom.remove();
    });
    bar.append(p, row);
    doc.body.appendChild(bar);
    publishHeight();
    sizeWatch?.observe(bar);
  }

  function signupPayload(): SignupTracking | undefined {
    const c = readConsent();
    if (!c || !hasAnyConsent(c)) return undefined;
    const attribution = parseAttribution(readCookie(doc, EBDA_ATTRIBUTION_COOKIE)) ?? undefined;
    const fbp = readCookie(doc, META_FBP_COOKIE) ?? undefined;
    const fbc = readCookie(doc, META_FBC_COOKIE) ?? attribution?.fbc;
    let phId: string | undefined;
    try {
      phId = phInstance?.get_distinct_id?.() || undefined;
    } catch {
      phId = undefined;
    }
    return {
      ...(attribution ? { attribution } : {}),
      ...(fbp ? { fbp } : {}),
      ...(fbc ? { fbc } : {}),
      ...(phId ? { phId } : {}),
      consent: { analytics: c.analytics, marketing: c.marketing },
    };
  }

  return {
    consent: readConsent,
    start,
    setConsent,
    track,
    pageView: () => track('page_view'),
    signupPayload,
    showBanner,
  };
}
