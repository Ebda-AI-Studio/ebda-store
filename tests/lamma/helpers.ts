import { expect, type Page } from '@playwright/test';
import path from 'node:path';

const AXE = path.join(process.cwd(), 'node_modules/axe-core/axe.min.js');
const PORT = process.env.LAMMA_PORT ?? '3400';
const HOST_BASE = process.env.LAMMA_HOST_BASE ?? 'localhost';

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

/** The category the manifest category screen uses (a menu page). */
export const TAGINES_PATH = '/products?category=tagines';
/** The portion-variant stuffed cabbage box: the checkout-data-flow case. */
export const PORTION_PDP = '/products/mahshi-koronb';
/** The optional-note kunafa (a dish with an order note, no variants). */
export const NOTE_PDP = '/products/kunafa-nabulsi';
/** An option-less, in-stock dish (second cart line, no-option PDP). */
export const PLAIN_PDP = '/products/okra-tagine';
/** The no-photo product. */
export const NOIMG_PDP = '/products/cooking-oil';

/**
 * Status and body of a URL through the BROWSER (its host resolver maps the store hosts to the local
 * stack; Playwright's Node-side request context cannot resolve them).
 */
export async function fetchVia(page: Page, url: string) {
  const res = await page.goto(url, { waitUntil: 'domcontentloaded' });
  return { status: res!.status(), text: await res!.text() };
}
