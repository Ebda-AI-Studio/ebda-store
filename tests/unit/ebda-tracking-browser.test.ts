// @vitest-environment jsdom
/**
 * Ebda own-ads tracking: the browser runtime. Proves the consent gate (nothing loads before
 * a yes), the unset-env no-op, event_id passing for Meta dedup, the banner and the signup payload.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createTracker,
  pixelQuerySensitive,
  posthogAssetsHost,
} from '@ebda/shared/tracking-browser';
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
// Match on the parsed host, never a substring of the URL (CodeQL js/incomplete-url-substring-sanitization).
const scriptsFrom = (host: string) =>
  scripts().filter(src => {
    try {
      return new URL(src).hostname === host;
    } catch {
      return false;
    }
  });

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
    expect(calls.slice(0, 2)).toEqual([
      ['set', 'autoConfig', false, '123456789'],
      ['consent', 'grant'],
    ]);
    expect(calls[2]).toEqual(['init', '123456789']);
    expect(calls[3]).toEqual(['track', 'PageView', {}, undefined]);
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
    expect(bar.textContent).toContain('ملفات');
    expect(bar.textContent).toContain('قبول');
    expect(bar.querySelector('a')!.getAttribute('href')).toBe('/privacy/');
    [...bar.querySelectorAll('button')].find(b => b.textContent === 'قبول')!.click();
    expect(document.getElementById('ebda-consent')).toBeNull();
    expect(t.consent()).toEqual({ v: 1, analytics: true, marketing: true });
  });
  it('English page gets English copy; Reject all stores a refusal', () => {
    document.documentElement.lang = 'en';
    const t = createTracker(CFG, window);
    t.showBanner();
    const bar = document.getElementById('ebda-consent')!;
    expect(bar.dir).toBe('ltr');
    [...bar.querySelectorAll('button')].find(b => b.textContent === 'Reject all')!.click();
    expect(t.consent()).toEqual({ v: 1, analytics: false, marketing: false });
  });
  it('is compact on a phone (MKT-IMPECCABLE-3): tighter padding, 12px type, 44px buttons side by side', () => {
    const real = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      matches: q === '(max-width:600px)',
    })) as typeof window.matchMedia;
    try {
      createTracker(CFG, window).showBanner();
      const bar = document.getElementById('ebda-consent')!;
      expect(bar.style.padding).toBe('8px 12px');
      expect(bar.style.bottom).toBe('8px');
      const buttons = [...(bar.querySelector('div') as HTMLElement).querySelectorAll('button')];
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
  it('COOKIE-UI-1: Reject and Accept are equals; Customize is a link-style button that reveals per-purpose choices', () => {
    const t = createTracker(CFG, window);
    t.showBanner();
    const bar = document.getElementById('ebda-consent')!;
    const [reject, accept] = [
      ...(bar.querySelector('div') as HTMLElement).querySelectorAll('button'),
    ];
    expect(reject!.style.cssText).toBe(accept!.style.cssText);
    const custom = [...bar.querySelectorAll('p button')].find(
      b => b.textContent === 'تخصيص'
    ) as HTMLButtonElement;
    expect(custom).toBeTruthy();
    custom.click();
    const boxes = [...bar.querySelectorAll('input[type=checkbox]')] as HTMLInputElement[];
    expect(boxes).toHaveLength(2);
    boxes[0]!.checked = true;
    [...bar.querySelectorAll('button')].find(b => b.textContent === 'حفظ اختياراتي')!.click();
    expect(document.getElementById('ebda-consent')).toBeNull();
    expect(t.consent()).toEqual({ v: 1, analytics: true, marketing: false });
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
      for (const label of ['قبول', 'رفض الكل']) {
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
      [...(bar.querySelector('div') as HTMLElement).querySelectorAll('button')][0]!.click();
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

describe('marketing Meta Pixel: consent, withdrawal, one init, Lead (no PII)', () => {
  const fbqOf = () =>
    (window as unknown as { fbq: { queue: unknown[][] } }).fbq.queue.map(a => [...a]);
  const inits = () => fbqOf().filter(a => a[0] === 'init');

  it('no consent yet: no fbq, no Meta script, nothing fired for page views or Lead', () => {
    const t = createTracker(CFG, window);
    t.start();
    t.pageView();
    t.track('contact_submitted');
    expect((window as unknown as { fbq?: unknown }).fbq).toBeUndefined();
    expect(scripts().some(s => s.includes('facebook'))).toBe(false);
  });

  it('accepting marketing loads fbevents.js once, inits once, PageView once, advanced matching off', () => {
    const t = createTracker(CFG, window);
    t.pageView(); // held while undecided
    t.setConsent({ analytics: false, marketing: true });
    t.start();
    t.start();
    expect(scriptsFrom('connect.facebook.net')).toHaveLength(1);
    expect(inits()).toEqual([['init', '123456789']]); // id only: no email/phone user data
    expect(fbqOf().filter(a => a[0] === 'track' && a[1] === 'PageView')).toHaveLength(1);
    expect(fbqOf()).toContainEqual(['set', 'autoConfig', false, '123456789']);
  });

  it('Lead carries no props; a later SPA route PageView is fired once per call, never re-inits', () => {
    setConsent(false, true);
    const t = createTracker(CFG, window);
    t.start();
    t.track('contact_submitted');
    t.pageView();
    t.pageView();
    expect(fbqOf()).toContainEqual(['track', 'Lead', {}, undefined]);
    expect(fbqOf().filter(a => a[1] === 'PageView')).toHaveLength(2);
    expect(inits()).toHaveLength(1);
  });

  it('withdrawing marketing consent stops every later event and revokes; it does not reload', () => {
    setConsent(false, true);
    const t = createTracker(CFG, window);
    t.start();
    t.pageView();
    const before = fbqOf().length;
    t.setConsent({ analytics: false, marketing: false });
    const afterRevoke = fbqOf().length;
    expect(fbqOf()).toContainEqual(['consent', 'revoke']);
    t.start();
    t.pageView();
    t.track('contact_submitted');
    expect(fbqOf().length).toBe(afterRevoke);
    expect(afterRevoke).toBe(before + 1);
    expect(scriptsFrom('connect.facebook.net')).toHaveLength(1);
  });
});

describe('Meta pixel is the tracker only: no auto PageView, no sensitive URL or referrer', () => {
  it('sets disablePushState / allowDuplicatePageViews BEFORE init', () => {
    setConsent(false, true);
    const order: string[] = [];
    const w = window as unknown as { fbq?: any };
    const t = createTracker(CFG, window);
    // preinstall a recording fbq so we see flag-vs-init order
    const fn: any = (...a: unknown[]) => order.push(`call:${a[0]}`);
    let dps: unknown;
    Object.defineProperty(fn, 'disablePushState', {
      set(v) {
        dps = v;
        order.push('disablePushState');
      },
      get: () => dps,
    });
    w.fbq = fn;
    t.start();
    expect(order.indexOf('disablePushState')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('disablePushState')).toBeLessThan(order.indexOf('call:init'));
    expect(w.fbq.disablePushState).toBe(true);
    expect(w.fbq.allowDuplicatePageViews).toBe(false);
  });

  it('no event (PageView or Lead) when the URL or the referrer carries email/phone/q', () => {
    setConsent(false, true);
    const t = createTracker(CFG, window);
    t.start();
    const q = () =>
      (window as unknown as { fbq: { queue: unknown[][] } }).fbq.queue.filter(a => a[0] === 'track')
        .length;
    window.history.replaceState(null, '', '/?email=a@b.com');
    t.pageView();
    t.track('contact_submitted');
    expect(q()).toBe(0);
    window.history.replaceState(null, '', '/');
    Object.defineProperty(document, 'referrer', {
      value: 'https://x.test/?phone=0100',
      configurable: true,
    });
    t.pageView();
    expect(q()).toBe(0);
    Object.defineProperty(document, 'referrer', { value: '', configurable: true });
    t.pageView();
    expect(q()).toBe(1);
  });
});

describe('pixel URL gate scrubs by key AND by value', () => {
  const blocked = [
    '?e-mail=x',
    '?email=x',
    '?e_mail=x',
    '?phone=x',
    '?mobile=x',
    '?tel=x',
    '?whatsapp=x',
    '?contact[email]=x',
    '?contact%5Bemail%5D=x',
    '?q=shoes',
    '?search=a',
    '?name=Ali',
    '?address=1',
    '?ref=a@b.com',
    '?ref=a%40b.com',
    '?x=01012345678',
    '?x=010-1234-5678',
    '?x=%2B20%201012%20345%20678',
    '?x=0101234',
    '?ref=\u0660\u0661\u0660\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667',
    '?ref=\u06F0\u06F1\u06F0\u06F0\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7',
    '?ref=%D9%A0%D9%A1%D9%A0%D9%A0%D9%A1%D9%A2%D9%A3%D9%A4%D9%A5%D9%A6%D9%A7',
    '?ref=a%2540b.com',
    '?%2565mail=x',
    '?x=%252B20%25201012%2520345%2520678',
  ];
  const clean = [
    '',
    '?',
    '?utm_source=meta&utm_medium=paid',
    '?fbclid=IwAR0abc12',
    '?ref=home',
    '?x=123456',
    '?fbclid=1234567890123',
  ];
  for (const q of blocked) it(`blocks ${q}`, () => expect(pixelQuerySensitive(q)).toBe(true));
  for (const q of clean)
    it(`allows ${q || '(empty)'}`, () => expect(pixelQuerySensitive(q)).toBe(false));

  it('blocks PageView and Lead for a value-only leak in the URL or the referrer', () => {
    setConsent(false, true);
    const t = createTracker(CFG, window);
    t.start();
    const n = () =>
      (window as unknown as { fbq: { queue: unknown[][] } }).fbq.queue.filter(a => a[0] === 'track')
        .length;
    window.history.replaceState(null, '', '/?ref=a@b.com');
    t.pageView();
    t.track('contact_submitted');
    window.history.replaceState(null, '', '/');
    Object.defineProperty(document, 'referrer', {
      value: 'https://x.test/?x=01012345678',
      configurable: true,
    });
    t.pageView();
    expect(n()).toBe(0);
    Object.defineProperty(document, 'referrer', { value: '', configurable: true });
  });
});

describe('pixel URL gate precision (#739 review)', () => {
  it('Meta campaign ids and utm values with long numbers do not silence the pixel', async () => {
    const { pixelQuerySensitive } = await import('../../packages/shared/src/tracking/browser');
    for (const q of [
      '?utm_id=120212345678901&utm_source=fb',
      '?ad_id=23851234567890123&adset_id=23851234567890124&campaign_id=23851234567890125',
      '?utm_content=23851234567890126',
      '?fbclid=IwAR1234567890abc',
    ])
      expect(pixelQuerySensitive(q), q).toBe(false);
  });
  it('short personal keys match only as a whole segment; long ones anywhere', async () => {
    const { pixelQuerySensitive } = await import('../../packages/shared/src/tracking/browser');
    for (const q of ['?faq=1', '?quote=yes', '?hotel=x', '?sequence=2'])
      expect(pixelQuerySensitive(q), q).toBe(false);
    for (const q of [
      '?q=shirt',
      '?tel=0100',
      '?search=x',
      '?contact[tel]=1',
      '?first_name=a',
      '?contact[email]=x',
    ])
      expect(pixelQuerySensitive(q), q).toBe(true);
  });
  it('a phone in a non-id key, or an @ even in a utm value, still silences it', async () => {
    const { pixelQuerySensitive } = await import('../../packages/shared/src/tracking/browser');
    expect(pixelQuerySensitive('?ref=01001234567')).toBe(true);
    expect(pixelQuerySensitive('?utm_content=a%40b.co')).toBe(true);
  });
});
