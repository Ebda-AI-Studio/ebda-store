// @vitest-environment jsdom
/**
 * Ebda own-ads tracking: the browser runtime. Proves the consent gate (nothing loads before
 * a yes), the unset-env no-op, event_id passing for Meta dedup, the banner and the signup payload.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTracker, posthogAssetsHost } from '@force/shared/tracking-browser';
import { EBDA_CONSENT_COOKIE, serializeConsent } from '@force/shared';

const CFG = {
  metaPixelId: '123456789',
  posthogKey: 'phc_test',
  posthogHost: 'https://eu.i.posthog.com',
};

function clearCookies() {
  for (const c of document.cookie.split('; ')) {
    const name = c.split('=')[0];
    if (name) document.cookie = `${name}=; path=/; max-age=0`;
  }
}
function setConsent(analytics: boolean, marketing: boolean) {
  document.cookie = `${EBDA_CONSENT_COOKIE}=${serializeConsent({ analytics, marketing })}; path=/`;
}
const scripts = () => [...document.head.querySelectorAll('script')].map(s => s.src);

beforeEach(() => {
  clearCookies();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  document.documentElement.lang = 'ar';
  delete (window as unknown as Record<string, unknown>).fbq;
  delete (window as unknown as Record<string, unknown>)._fbq;
  window.history.replaceState(null, '', '/');
});

describe('consent gate', () => {
  it('loads NO script and sets NO cookie before a decision', () => {
    const t = createTracker(CFG, window);
    t.start();
    t.pageView();
    t.track('signup_submitted', { eventId: 'lead_1' });
    expect(scripts()).toEqual([]);
    expect((window as unknown as { fbq?: unknown }).fbq).toBeUndefined();
    expect(document.cookie).toBe('');
  });

  it('declined: nothing loads, held events are dropped, later events are no-ops', () => {
    const t = createTracker(CFG, window);
    t.pageView();
    t.setConsent({ analytics: false, marketing: false });
    t.track('store_created', { eventId: 'store_1' });
    expect(scripts()).toEqual([]);
    expect((window as unknown as { fbq?: unknown }).fbq).toBeUndefined();
    expect(t.signupPayload()).toBeUndefined();
  });

  it('accepted: loads Meta + PostHog and replays the events held while undecided', () => {
    const t = createTracker(CFG, window);
    t.pageView(); // held
    t.setConsent({ analytics: true, marketing: true });
    expect(scripts()).toEqual([
      'https://connect.facebook.net/en_US/fbevents.js',
      'https://eu-assets.i.posthog.com/static/array.js',
    ]);
    const fbq = (window as unknown as { fbq: { queue: unknown[][] } }).fbq;
    const calls = fbq.queue.map(a => [...a]);
    expect(calls[0]).toEqual(['init', '123456789']);
    expect(calls[1]).toEqual(['track', 'PageView', {}, undefined]);
  });

  it('marketing-only consent loads Meta but not PostHog', () => {
    createTracker(CFG, window).setConsent({ analytics: false, marketing: true });
    expect(scripts()).toEqual(['https://connect.facebook.net/en_US/fbevents.js']);
  });

  it('analytics-only consent loads PostHog but never defines the Meta pixel', () => {
    createTracker(CFG, window).setConsent({ analytics: true, marketing: false });
    expect(scripts()).toEqual(['https://eu-assets.i.posthog.com/static/array.js']);
    expect((window as unknown as { fbq?: unknown }).fbq).toBeUndefined();
  });

  it('a returning visitor with a stored yes loads on start()', () => {
    setConsent(true, true);
    createTracker(CFG, window).start();
    expect(scripts()).toHaveLength(2);
  });
});

describe('unset env', () => {
  it('no pixel id and no PostHog key: consent granted, still no script and no error', () => {
    const t = createTracker({}, window);
    expect(() => {
      t.setConsent({ analytics: true, marketing: true });
      t.pageView();
      t.track('registration_completed', { eventId: 'reg_1' });
    }).not.toThrow();
    expect(scripts()).toEqual([]);
    expect((window as unknown as { fbq?: unknown }).fbq).toBeUndefined();
  });
});

describe('Meta event names and dedup ids', () => {
  it('passes eventID for dedup and uses trackCustom for StoreCreated', () => {
    setConsent(false, true);
    const t = createTracker(CFG, window);
    t.track('registration_completed', { eventId: 'reg_u1' });
    t.track('store_created', { eventId: 'store_s1' });
    t.track('pricing_viewed', { props: { content_name: 'pricing' } });
    const q = (window as unknown as { fbq: { queue: unknown[][] } }).fbq.queue.map(a => [...a]);
    expect(q).toContainEqual(['track', 'CompleteRegistration', {}, { eventID: 'reg_u1' }]);
    expect(q).toContainEqual(['trackCustom', 'StoreCreated', {}, { eventID: 'store_s1' }]);
    expect(q).toContainEqual(['track', 'ViewContent', { content_name: 'pricing' }, undefined]);
  });
});

describe('banner', () => {
  it('shows Arabic copy on an Arabic page and Accept grants + removes it', () => {
    const t = createTracker({ ...CFG, privacyUrl: '/privacy/' }, window);
    t.showBanner();
    const bar = document.getElementById('ebda-consent')!;
    expect(bar.dir).toBe('rtl');
    expect(bar.textContent).toContain('كوكيز');
    expect(bar.textContent).toContain('موافق');
    expect(bar.querySelector('a')!.getAttribute('href')).toBe('/privacy/');
    [...bar.querySelectorAll('button')].find(b => b.textContent === 'موافق')!.click();
    expect(document.getElementById('ebda-consent')).toBeNull();
    expect(t.consent()).toEqual({ v: 1, analytics: true, marketing: true });
  });
  it('English page gets English copy; Decline stores a refusal', () => {
    document.documentElement.lang = 'en';
    const t = createTracker(CFG, window);
    t.showBanner();
    const bar = document.getElementById('ebda-consent')!;
    expect(bar.dir).toBe('ltr');
    [...bar.querySelectorAll('button')].find(b => b.textContent === 'Decline')!.click();
    expect(t.consent()).toEqual({ v: 1, analytics: false, marketing: false });
  });
  it('does not reappear once decided, unless forced (cookie settings link)', () => {
    setConsent(false, false);
    const t = createTracker(CFG, window);
    t.showBanner();
    expect(document.getElementById('ebda-consent')).toBeNull();
    t.showBanner(true);
    expect(document.getElementById('ebda-consent')).not.toBeNull();
  });
});

describe('attribution + signup payload', () => {
  it('captures utm/fbclid on landing (after consent) and forwards them with fbc', () => {
    window.history.replaceState(null, '', '/?utm_source=meta&utm_campaign=launch&fbclid=AbC');
    const t = createTracker(CFG, window);
    t.setConsent({ analytics: true, marketing: true });
    const p = t.signupPayload()!;
    expect(p.consent).toEqual({ analytics: true, marketing: true });
    expect(p.attribution).toMatchObject({
      utm_source: 'meta',
      utm_campaign: 'launch',
      fbclid: 'AbC',
    });
    expect(p.fbc).toMatch(/^fb\.1\.\d+\.AbC$/);
    expect(document.cookie).toContain('_fbc=fb.1.');
    expect(document.cookie).toContain('ebda_attr=');
  });
  it("reads Meta's _fbp cookie when the pixel has set it", () => {
    setConsent(false, true);
    document.cookie = '_fbp=fb.1.1700000000000.1234567890; path=/';
    expect(createTracker(CFG, window).signupPayload()!.fbp).toBe('fb.1.1700000000000.1234567890');
  });
  it('stores no attribution when the visitor never consented', () => {
    window.history.replaceState(null, '', '/?utm_source=meta&fbclid=AbC');
    const t = createTracker(CFG, window);
    t.start();
    expect(document.cookie).not.toContain('ebda_attr');
    expect(t.signupPayload()).toBeUndefined();
  });
});

describe('posthogAssetsHost', () => {
  it('maps the ingest host to the assets host', () => {
    expect(posthogAssetsHost('https://eu.i.posthog.com')).toBe('https://eu-assets.i.posthog.com');
    expect(posthogAssetsHost('https://us.i.posthog.com')).toBe('https://us-assets.i.posthog.com');
  });
});
