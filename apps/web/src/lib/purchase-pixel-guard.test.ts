// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// MarketingPixels imports these; trackPurchase itself reads only `window`.
vi.mock('next/script', () => ({ __esModule: true, default: () => null }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('../contexts/FeatureContext', () => ({
  useFeatures: () => ({ isEnabled: () => true }),
}));
vi.mock('../contexts/ConsentContext', () => ({
  useConsent: () => ({ consent: { marketing: true } }),
}));

/**
 * Fresh modules per "page load": the in-memory set must not leak between
 * loads, while the Map-backed storage below (the browser's) persists.
 */
async function load() {
  vi.resetModules();
  const guard = await import('./purchase-pixel-guard');
  const { trackPurchase } = await import('../components/MarketingPixels');
  return { ...guard, trackPurchase };
}

/**
 * A Map-backed Storage. jsdom's own localStorage is not reliably present in
 * this runner (Node's built-in `localStorage` global shadows it), and the
 * behaviour under test is ours, not the browser's.
 */
const store = new Map<string, string>();
const fakeStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  clear: () => store.clear(),
};

type PixelWindow = { fbq?: unknown; gtag?: unknown; ttq?: unknown };
const PIXEL_GLOBALS = ['fbq', 'gtag', 'ttq', 'snaptr', 'twq', 'pintrk'] as const;

function purchase(orderId: string) {
  return { orderId, contentIds: ['p1'], numItems: 1, value: 12.5, currency: 'KWD' };
}

/** What SuccessClient does for a confirmed order, on one page load. */
async function successPageLoad(orderId: string) {
  const { firePurchasePixelOnce, trackPurchase } = await load();
  return firePurchasePixelOnce(orderId, () => trackPurchase(purchase(orderId)));
}

describe('purchase pixel once-per-order guard (#1346)', () => {
  beforeEach(() => {
    store.clear();
    Object.defineProperty(window, 'localStorage', { value: fakeStorage, configurable: true });
  });
  afterEach(() => {
    for (const g of PIXEL_GLOBALS) delete (window as unknown as Record<string, unknown>)[g];
  });

  it('no pixel on the page (consent not yet given): the order is NOT marked', async () => {
    expect(await successPageLoad('o1')).toBe(false);
    const { hasPurchasePixelFired } = await load();
    expect(hasPurchasePixelFired('o1')).toBe(false);
    expect(store.size).toBe(0);
  });

  it('the reload after accepting consent fires exactly once, then never again', async () => {
    expect(await successPageLoad('o1')).toBe(false); // pre-consent visit
    const fbq = vi.fn();
    (window as PixelWindow).fbq = fbq;
    expect(await successPageLoad('o1')).toBe(true); // reload with pixels
    expect(await successPageLoad('o1')).toBe(false); // later refresh
    expect(fbq.mock.calls.filter(c => c[1] === 'Purchase')).toHaveLength(1);
  });

  it('pixels present: the fire is marked, and a second mount does not fire again', async () => {
    const gtag = vi.fn();
    (window as PixelWindow).gtag = gtag;
    expect(await successPageLoad('o1')).toBe(true);
    expect(store.has('force:purchase-pixel-fired:o1')).toBe(true);
    expect(await successPageLoad('o1')).toBe(false);
    expect(gtag.mock.calls.filter(c => c[1] === 'purchase')).toHaveLength(1);
  });

  it('same page, called twice: fires once (in-memory dedup)', async () => {
    const fbq = vi.fn();
    (window as PixelWindow).fbq = fbq;
    const { firePurchasePixelOnce, trackPurchase } = await load();
    expect(firePurchasePixelOnce('o1', () => trackPurchase(purchase('o1')))).toBe(true);
    expect(firePurchasePixelOnce('o1', () => trackPurchase(purchase('o1')))).toBe(false);
    expect(firePurchasePixelOnce('o2', () => trackPurchase(purchase('o2')))).toBe(true);
    expect(fbq.mock.calls.filter(c => c[1] === 'Purchase')).toHaveLength(2);
  });

  it('still guards within the page when storage throws', async () => {
    (window as PixelWindow).fbq = vi.fn();
    const { firePurchasePixelOnce } = await load();
    const g = vi.spyOn(fakeStorage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const s = vi.spyOn(fakeStorage, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const track = vi.fn(() => true);
    expect(firePurchasePixelOnce('o1', track)).toBe(true);
    expect(firePurchasePixelOnce('o1', track)).toBe(false);
    expect(track).toHaveBeenCalledTimes(1);
    g.mockRestore();
    s.mockRestore();
  });

  it('ignores an empty order id', async () => {
    const { firePurchasePixelOnce } = await load();
    const track = vi.fn(() => true);
    expect(firePurchasePixelOnce('', track)).toBe(false);
    expect(track).not.toHaveBeenCalled();
  });
});

describe('SuccessClient wiring', () => {
  it('reports the Purchase pixel only through firePurchasePixelOnce', () => {
    const src = readFileSync(join(__dirname, '../app/checkout/success/SuccessClient.tsx'), 'utf8');
    expect(src.match(/\btrackPurchase\(/g)).toHaveLength(1);
    expect(src).toMatch(
      /firePurchasePixelOnce\(\s*fetchedOrder\.id,\s*\(\)\s*=>\s*trackPurchase\(/
    );
  });
});
