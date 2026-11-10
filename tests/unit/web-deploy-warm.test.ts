/**
 * Ruling WEB-COLD-1 + EDGE-BUILD-1 (+ WEB-COLD-2): the storefront deploy ends by warming every demo store in BOTH
 * languages: home, listing and one product page, each 5xx retried once and logged.
 * The HTML edge cache is keyed by the Worker version, so each deploy starts it empty; warming only /ar left the
 * first /en visitor with the cold render. Pinned here: both languages, best effort, and a cap that covers the
 * worst case so the step is never killed half way through the list.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ATTEMPTS,
  LANGS,
  PAGES_PER_LANG,
  TIMEOUT_MS,
  demoLabels,
  formatLine,
  pathsFor,
  warmAll,
  warmOne,
  // @ts-expect-error plain .mjs script, no types
} from '../../scripts/ci/warm-storefront.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { DEMO_HOSTS } from '../../apps/web/src/lib/demo-hosts';

const ROOT = path.resolve(__dirname, '../..');
type Step = {
  name?: string;
  run?: string;
  'timeout-minutes'?: number;
  'continue-on-error'?: boolean;
};
const wf = yaml.load(
  readFileSync(path.join(ROOT, '.github/workflows/cf-web-deploy.yml'), 'utf8')
) as { jobs: { deploy: { steps: Step[] } } };
const steps = wf.jobs.deploy.steps;
const warm = steps.find(s => /^Warm the storefront/.test(s.name ?? ''));

describe('cf-web-deploy warm step', () => {
  it('is the last deploy step and can never fail the deploy', () => {
    expect(warm).toBeDefined();
    expect(steps[steps.length - 1]).toBe(warm);
    expect(warm!['continue-on-error']).toBe(true);
  });

  it('runs the warm script, which reads every demo host from demo-hosts.ts', () => {
    expect(warm!.run!.trim()).toBe('node scripts/ci/warm-storefront.mjs');
    const source = readFileSync(path.join(ROOT, 'apps/web/src/lib/demo-hosts.ts'), 'utf8');
    expect(demoLabels(source).sort()).toEqual(Object.values(DEMO_HOSTS).sort());
  });

  it('warms home, listing and one product page in BOTH languages', () => {
    expect(LANGS).toEqual(['ar', 'en']);
    expect(pathsFor('ar', 'black-tea')).toEqual(['/ar', '/ar/products', '/ar/products/black-tea']);
    expect(pathsFor('en', null)).toEqual(['/en', '/en/products']);
    expect(pathsFor('en', 'x').length).toBe(PAGES_PER_LANG);
  });

  it('caps the step above the worst case (hosts x (API read + languages x pages x attempts) x timeout)', () => {
    const hosts = Object.values(DEMO_HOSTS).length;
    const worstSeconds =
      (hosts * (1 + LANGS.length * PAGES_PER_LANG * ATTEMPTS) * TIMEOUT_MS) / 1000;
    expect(warm!['timeout-minutes']! * 60).toBeGreaterThanOrEqual(worstSeconds);
  });
});

describe('warm-storefront retry + log (WEB-COLD-2)', () => {
  const clock = () => {
    let t = 0;
    return () => (t += 100);
  };
  const res = (status: number) => ({
    status,
    ok: status < 400,
    arrayBuffer: async () => new ArrayBuffer(0),
  });

  it('retries a 5xx once and logs both attempts', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(res(500)).mockResolvedValueOnce(res(200));
    const attempts = await warmOne('https://x/ar', { fetchImpl, now: clock() });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(attempts.map((a: { status: number | string }) => a.status)).toEqual([500, 200]);
    expect(formatLine('https://x/ar', attempts)).toBe(
      'warm https://x/ar: 500 ttfb=0.10s -> retry 200 ttfb=0.10s'
    );
  });

  it('retries a network failure once, never more, and never throws', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('reset'));
    const attempts = await warmOne('https://x/en', { fetchImpl, now: clock() });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(attempts.map((a: { status: number | string }) => a.status)).toEqual([
      'failed',
      'failed',
    ]);
  });

  it('does not retry a 2xx, 3xx or 4xx', async () => {
    for (const status of [200, 308, 404]) {
      const fetchImpl = vi.fn().mockResolvedValue(res(status));
      await warmOne('https://x/', { fetchImpl, now: clock() });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('warms every page of every host and language, product page from the API slug', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      if (url.includes('api.ebda.app'))
        return { ok: true, json: async () => ({ data: { products: [{ slug: 'black-tea' }] } }) };
      return res(200);
    });
    const lines = await warmAll(['storedemo-lamma'], { fetchImpl, now: clock(), log: () => {} });
    expect(lines).toHaveLength(6);
    expect(urls).toContain('https://storedemo-lamma.ebda.app/ar/products/black-tea');
    expect(urls).toContain('https://storedemo-lamma.ebda.app/en/products');
  });
});
