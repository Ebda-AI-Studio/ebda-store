import { expect, type Page } from '@playwright/test';
import path from 'node:path';

const AXE = path.join(process.cwd(), 'node_modules/axe-core/axe.min.js');
const PORT = process.env.JASMINE_PORT ?? '3300';
const HOST_BASE = process.env.JASMINE_HOST_BASE ?? 'localhost';

export const hostOf = (store: string) => `http://${store}.${HOST_BASE}:${PORT}`;

/** Open `p` on `store` in `lang` with the consent banner already accepted. */
export async function open(page: Page, store: string, lang: 'ar' | 'en', p: string) {
  const origin = hostOf(store);
  await page.context().addCookies([
    { name: 'force-language', value: lang, url: origin },
    {
      name: 'force-cookie-consent',
      value: encodeURIComponent(
        JSON.stringify({ marketing: false, v: 1, ts: '2026-10-07T00:00:00Z' })
      ),
      url: origin,
    },
  ]);
  const res = await page.goto(`${origin}${p}`, { waitUntil: 'networkidle' });
  expect(res, p).not.toBeNull();
  return res!;
}

export interface AxeViolation {
  id: string;
  impact: string | null;
  targets: string[];
}

export async function runAxe(page: Page): Promise<AxeViolation[]> {
  await page.addScriptTag({ path: AXE });
  return page.evaluate(async () => {
    // @ts-expect-error injected
    const r = await window.axe.run(document, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
      },
    });
    return r.violations.map(
      (v: { id: string; impact: string; nodes: Array<{ target: string[] }> }) => ({
        id: v.id,
        impact: v.impact,
        targets: v.nodes.map(n => n.target.join(' ')).slice(0, 3),
      })
    );
  });
}

/** The skin-type tag the chips and the manifest category screen use. */
export const TAG = 'Oily skin';
export const TAG_PATH = `/products?tag=${encodeURIComponent(TAG)}`;
/** The Shade x Size lipstick: the checkout-data-flow case. */
export const SHADE_PDP = '/products/matte-lipstick';
/** An option-less product (second cart line, no-option PDP). */
export const PLAIN_PDP = '/products/sunscreen-spf50';
/** The no-photo product. */
export const NOIMG_PDP = '/products/makeup-brush-set';

/**
 * Status and body of a URL through the BROWSER (its host resolver maps the store hosts to the local
 * stack; Playwright's Node-side request context cannot resolve them).
 */
export async function fetchVia(page: Page, url: string) {
  const res = await page.goto(url, { waitUntil: 'domcontentloaded' });
  return { status: res!.status(), text: await res!.text() };
}
