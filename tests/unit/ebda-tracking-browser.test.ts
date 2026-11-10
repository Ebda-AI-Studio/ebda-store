// @vitest-environment jsdom
/**
 * Ebda own-ads tracking: the browser runtime. Proves the consent gate (nothing loads before
 * a yes), the unset-env no-op, event_id passing for Meta dedup, the banner and the signup payload.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTracker, posthogAssetsHost } from '@ebda/shared/tracking-browser';
import { EBDA_CONSENT_COOKIE, serializeConsent } from '@ebda/shared';

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
  document.documentElement.style.removeProperty('--ebda-consent-h');
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

describe('no Meta pixel on a URL that carries a token, a term, an email or a phone (PIXEL-CONSENT-1)', () => {
  it.each(['?token=abc123', '?q=01012345678', '?email=a%40b.com', '?phone=01012345678'])(
    'consented on %s: Meta never loads and no event reaches it',
    search => {
      window.history.replaceState(null, '', `/verify-email${search}`);
      const t = createTracker(CFG, window);
      t.pageView();
      t.setConsent({ analytics: false, marketing: true });
      t.track('registration_completed', { eventId: 'reg_1' });
      expect(scripts()).toEqual([]);
      expect((window as unknown as { fbq?: unknown }).fbq).toBeUndefined();
    }
  );

  it('an already-loaded pixel is not fed an event on a blocked URL, and is again on a clean one', () => {
    const t = createTracker(CFG, window);
    t.setConsent({ analytics: false, marketing: true });
    const fbq = (window as unknown as { fbq: { queue: unknown[][] } }).fbq;
    const before = fbq.queue.length;
    window.history.replaceState(null, '', '/verify-email?token=abc123');
    t.track('registration_completed', { eventId: 'reg_1' });
    expect(fbq.queue.length).toBe(before);
    window.history.replaceState(null, '', '/onboarding?utm_source=meta');
    t.track('store_created', { eventId: 'store_1' });
    expect(fbq.queue.length).toBe(before + 1);
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
  it('is compact on a phone (MKT-IMPECCABLE-3): tighter padding, 13px type, 44px buttons side by side', () => {
    const real = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      matches: q === '(max-width:600px)',
    })) as typeof window.matchMedia;
    try {
      createTracker(CFG, window).showBanner();
      const bar = document.getElementById('ebda-consent')!;
      expect(bar.style.padding).toBe('10px 12px');
      expect(bar.style.bottom).toBe('8px');
      const buttons = [...bar.querySelectorAll('button')];
      expect(buttons).toHaveLength(2);
      for (const b of buttons) {
        expect(b.style.minHeight).toBe('44px');
        expect(b.style.flex).toContain('1');
      }
      expect((bar.querySelector('div') as HTMLElement).style.flexWrap).toBe('');
    } finally {
      window.matchMedia = real;
    }
  });
  it('keeps the roomy desktop bar when the viewport is wide', () => {
    createTracker(CFG, window).showBanner();
    const bar = document.getElementById('ebda-consent')!;
    expect(bar.style.padding).toBe('16px');
    expect(bar.style.bottom).toBe('16px');
  });
  it('publishes its height as --ebda-consent-h (px) while shown and removes it on either answer', () => {
    // Pre-QA sweep finding 8: the fixed bar covered the last row of the phone menu. Page chrome
    // reads this property to stop above the bar, so the name and the unit are a contract.
    const root = document.documentElement;
    const real = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      return { height: this.id === 'ebda-consent' ? 132.4 : 0 } as DOMRect;
    };
    try {
      for (const label of ['موافق', 'لا، شكرًا']) {
        clearCookies();
        expect(root.style.getPropertyValue('--ebda-consent-h')).toBe('');
        createTracker(CFG, window).showBanner();
        expect(root.style.getPropertyValue('--ebda-consent-h')).toBe('133px');
        const bar = document.getElementById('ebda-consent')!;
        [...bar.querySelectorAll('button')].find(b => b.textContent === label)!.click();
        expect(document.getElementById('ebda-consent')).toBeNull();
        expect(root.style.getPropertyValue('--ebda-consent-h')).toBe('');
      }
    } finally {
      Element.prototype.getBoundingClientRect = real;
    }
  });
  it('follows the bar when it changes height, and stops watching once it is gone', () => {
    const root = document.documentElement;
    const w = window as unknown as { ResizeObserver?: unknown };
    const realRO = w.ResizeObserver;
    const realRect = Element.prototype.getBoundingClientRect;
    let height = 133;
    let fire: () => void = () => {};
    const seen = { observed: null as Element | null, disconnected: false };
    w.ResizeObserver = class {
      constructor(cb: () => void) {
        fire = cb;
      }
      observe(el: Element) {
        seen.observed = el;
      }
      disconnect() {
        seen.disconnected = true;
      }
    };
    Element.prototype.getBoundingClientRect = function (this: Element) {
      return { height: this.id === 'ebda-consent' ? height : 0 } as DOMRect;
    };
    try {
      createTracker(CFG, window).showBanner();
      const bar = document.getElementById('ebda-consent')!;
      expect(seen.observed).toBe(bar);
      height = 152; // the copy wrapped onto one more line
      fire();
      expect(root.style.getPropertyValue('--ebda-consent-h')).toBe('152px');
      bar.querySelector('button')!.click();
      expect(seen.disconnected).toBe(true);
      expect(root.style.getPropertyValue('--ebda-consent-h')).toBe('');
    } finally {
      Element.prototype.getBoundingClientRect = realRect;
      w.ResizeObserver = realRO;
    }
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
