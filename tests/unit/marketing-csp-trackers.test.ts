/**
 * The marketing CSP must allow every host the consent-gated trackers load from (Meta Pixel, PostHog), or ad conversions
 * and analytics go dark after the visitor accepts the banner. The hosts are DERIVED from the tracker source (the
 * fbevents URL constant, the default PostHog api host and its assets-host mapping), so a tracker change that adds or
 * moves a host fails here instead of silently being blocked in the browser.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { posthogAssetsHost } from '../../packages/shared/src/tracking/browser';

const root = resolve(__dirname, '../..');
const tracker = readFileSync(resolve(root, 'packages/shared/src/tracking/browser.ts'), 'utf8');
const headers = readFileSync(resolve(root, 'apps/marketing/public/_headers'), 'utf8');
const csp = /Content-Security-Policy:\s*(.+)/.exec(headers)![1]!;
const directive = (name: string) =>
  (new RegExp(`(?:^|;)\\s*${name}\\s+([^;]+)`).exec(csp)?.[1] ?? '').split(/\s+/);
const origin = (u: string) => new URL(u).origin;

const metaSrc = /const META_SRC = '([^']+)'/.exec(tracker)![1]!;
const phApi = /config\.posthogHost \|\| '([^']+)'/.exec(tracker)![1]!;
const phAssets = posthogAssetsHost(phApi);

describe('marketing CSP allows the tracker hosts', () => {
  it('derived the hosts from the tracker source', () => {
    expect(origin(metaSrc)).toBe('https://connect.facebook.net');
    expect(origin(phAssets)).not.toBe(origin(phApi));
  });
  it.each([
    ['Meta fbevents.js', () => origin(metaSrc)],
    ['PostHog array.js', () => origin(phAssets)],
  ])('script-src allows %s', (_n, host) => {
    expect(directive('script-src')).toContain(host());
  });
  it.each([
    ['Meta Pixel beacons', () => origin(metaSrc)],
    ['Meta Pixel www', () => 'https://www.facebook.com'],
    ['PostHog capture', () => origin(phApi)],
    ['PostHog assets', () => origin(phAssets)],
  ])('connect-src allows %s', (_n, host) => {
    expect(directive('connect-src')).toContain(host());
  });
  it('keeps the floor: no wildcard script host, no unsafe-eval', () => {
    expect(directive('script-src').join(' ')).not.toMatch(/\*|unsafe-eval/);
  });
});
