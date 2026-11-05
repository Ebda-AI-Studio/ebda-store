import { expect, type Page } from '@playwright/test';
import path from 'node:path';

const AXE = path.join(process.cwd(), 'node_modules/axe-core/axe.min.js');
const PORT = process.env.SOUQ_PORT ?? '3200';

// SOUQ_HOST_BASE=localhost-b5.test drives a PRODUCTION web build, which refuses `.localhost` store
// hosts (same as the other template suites; playwright.souq.config.ts maps the name to loopback).
const HOST_BASE = process.env.SOUQ_HOST_BASE ?? 'localhost';

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

/**
 * GET a URL through the BROWSER, which maps `*.localhost-b5.test` to loopback; Playwright's Node-side
 * request context cannot resolve those names (SOUQ_HOST_BASE on a production build).
 */
export async function fetchVia(page: Page, url: string) {
  const res = await page.goto(url, { waitUntil: 'domcontentloaded' });
  return { status: res!.status(), text: await res!.text() };
}
