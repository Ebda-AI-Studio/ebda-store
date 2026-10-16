// @vitest-environment jsdom
/**
 * Search program P0 Task 5, fix round 2 (same class as the Sentry scrub): the storefront search
 * page is `/search?q=<term>` and PostHog's automatic `$pageview` sends the full URL tied to the
 * visitor's distinct_id. Every PostHog init passes `before_send: scrubPostHogCapture`.
 *
 * This runs the REAL posthog-js capture pipeline (jsdom): the scrubber is the first
 * `before_send`, a collector is the second and returns null (nothing goes over the network).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import posthog from 'posthog-js';
import { scrubPostHogCapture } from '@ebda/shared';

const PHONE = '01012345678';
const seen: Array<Record<string, unknown>> = [];

beforeAll(() => {
  window.history.replaceState({}, '', `/search?q=${PHONE}&sort=newest`);
  Object.defineProperty(document, 'referrer', {
    value: `https://shop.example/search?q=${encodeURIComponent('٠١٠١٢٣٤٥٦٧٨')}`,
    configurable: true,
  });
  posthog.init('phc_test', {
    api_host: 'https://eu.i.posthog.com',
    ip: false,
    capture_pageview: false,
    autocapture: false,
    disable_session_recording: true,
    advanced_disable_flags: true,
    persistence: 'memory',
    before_send: [
      scrubPostHogCapture,
      cr => {
        if (cr) seen.push(cr as unknown as Record<string, unknown>);
        return null; // never send
      },
    ],
  });
});

describe('PostHog captures never carry a search/PII query value', () => {
  it('a /search?q=<phone> pageview leaves with [Filtered]', () => {
    posthog.capture('$pageview');
    const pv = seen.find(e => e.event === '$pageview');
    expect(pv).toBeDefined();
    const props = pv!.properties as Record<string, unknown>;
    expect(props.$current_url).toBe('http://localhost:3000/search?q=[Filtered]&sort=newest');
    const all = JSON.stringify(seen);
    expect(all).not.toContain(PHONE);
    expect(all).not.toContain(encodeURIComponent('٠١٠١٢٣٤٥٦٧٨'));
    expect(all).toContain('sort=newest'); // the rest of the URL stays readable
  });

  it('custom URL properties are scrubbed too', () => {
    posthog.capture('search_used', { url: `/products?search=${PHONE}`, results: 0 });
    const ev = seen.find(e => e.event === 'search_used');
    expect((ev!.properties as Record<string, unknown>).url).toBe('/products?search=[Filtered]');
  });
});
