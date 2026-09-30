/**
 * The three pure-CSS bar charts in the admin (Sales Overview, Answer-Engine
 * citation trend, Search Console trend) must draw bars with a NON-ZERO height.
 *
 * The defect (2026-09-30 analytics audit, finding 1): each chart is a row with
 * `items-end h-40`/`h-32`, holding one `flex flex-col` column per bar, and the
 * bar inside sets `height: N%`. `items-end` stops the column from stretching,
 * so its height is indefinite and `N%` resolves to `auto` = 0px. The charts
 * drew axis labels and no bars, on every store and every period. The fix is
 * `h-full justify-end` on the column.
 *
 * Two layers, because a class name is not a rendered pixel:
 *  1. Static markup (always runs): every bar column carries `h-full` and
 *     `justify-end`.
 *  2. Real layout (Chromium): the charts' markup is rendered with the admin's
 *     own Tailwind config compiled for exactly that markup, loaded into
 *     headless Chromium, and each bar's `offsetHeight` is measured. This is the
 *     check that saw 0/0/0 px before the fix. It needs a Chromium binary: the
 *     one Playwright resolves, or `CHROMIUM_PATH`. Without one it is SKIPPED
 *     with a warning — not passed — and layer 1 is the only guard.
 *
 * Mutation proof: remove `h-full` from the column in RevenueChart.tsx → both
 * layers go red for the Sales Overview chart.
 */

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

import { SimpleBarChart } from '@admin/app/stores/[id]/analytics/_components/RevenueChart';
import { TrendChart } from '@admin/app/stores/[id]/answer-engine/_components/TrendChart';
import { GscTrendChart } from '@admin/app/stores/[id]/answer-engine/_components/GscTrendChart';

const VALUES = [10, 50, 100];

const charts: Record<string, string> = {
  RevenueChart: renderToStaticMarkup(
    <SimpleBarChart
      data={VALUES.map((v, i) => ({ date: `2026-09-0${i + 1}`, revenue: v, orders: v }))}
      dataKey="revenue"
      granularity="day"
      label="revenue"
      maxLabel="max"
    />
  ),
  TrendChart: renderToStaticMarkup(
    <TrendChart
      trend={VALUES.map((v, i) => ({
        weekStart: `2026-09-0${i + 1}`,
        citedRate: v / 100,
        citedCount: v,
        totalChecks: 100,
      }))}
    />
  ),
  GscTrendChart: renderToStaticMarkup(
    <GscTrendChart
      trend={VALUES.map((v, i) => ({
        date: `2026-09-0${i + 1}`,
        impressions: v,
        clicks: 0,
        ctr: 0,
        position: 1,
      }))}
    />
  ),
};

function columnClassLists(html: string): string[] {
  return [...html.matchAll(/<div data-chart-column="true" class="([^"]*)"/g)].map(m => m[1]);
}

describe('admin bar charts — static layout contract', () => {
  for (const [name, html] of Object.entries(charts)) {
    it(`${name}: every bar column is h-full + justify-end`, () => {
      const cols = columnClassLists(html);
      expect(cols).toHaveLength(VALUES.length);
      for (const cls of cols) {
        const tokens = cls.split(/\s+/);
        expect(tokens).toContain('h-full');
        expect(tokens).toContain('justify-end');
      }
    });
  }
});

// ─── Real layout in Chromium ────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '../..');
const adminRequire = createRequire(path.join(ROOT, 'apps/admin/package.json'));

function resolveChromium(): string | null {
  if (process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH)) {
    return process.env.CHROMIUM_PATH;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { chromium } = require('playwright');
    const p = chromium.executablePath();
    return p && existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

const chromiumPath = resolveChromium();
if (!chromiumPath) {
  console.warn(
    '[analytics-bar-charts-render] no Chromium binary — the pixel-height layer is SKIPPED ' +
      '(set CHROMIUM_PATH or run `npx playwright install chromium`). Static layer still ran.'
  );
}

async function compileTailwind(html: string): Promise<string> {
  const postcss = adminRequire('postcss');
  const tailwindcss = adminRequire('tailwindcss');
  const config = adminRequire('./tailwind.config.js');
  const result = await postcss([
    tailwindcss({ ...config, content: [{ raw: html, extension: 'html' }] }),
  ]).process('@tailwind base;\n@tailwind components;\n@tailwind utilities;', { from: undefined });
  return result.css;
}

describe.skipIf(!chromiumPath)('admin bar charts — measured bar heights in Chromium', () => {
  it('every bar in all three charts renders taller than 0px, in value order', async () => {
    const allHtml = Object.values(charts).join('\n');
    const css = await compileTailwind(allHtml);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ executablePath: chromiumPath! });
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 1200 } });
      const sections = Object.entries(charts)
        .map(
          ([name, html]) => `<section data-chart="${name}" style="width:600px">${html}</section>`
        )
        .join('');
      await page.setContent(
        `<!doctype html><html><head><style>${css}</style></head><body>${sections}</body></html>`
      );
      const heights: Record<string, number[]> = await page.evaluate(() => {
        const out: Record<string, number[]> = {};
        document.querySelectorAll('section[data-chart]').forEach(sec => {
          out[(sec as HTMLElement).dataset.chart!] = Array.from(
            sec.querySelectorAll('[data-chart-bar]')
          ).map(b => (b as HTMLElement).getBoundingClientRect().height);
        });
        return out;
      });

      for (const name of Object.keys(charts)) {
        const h = heights[name];
        expect(h, `${name} bars`).toHaveLength(VALUES.length);
        for (const px of h) expect(px, `${name} bar height`).toBeGreaterThan(0);
        // Taller value → taller bar; the 100% bar is a substantial fraction
        // of the plot area (h-32 = 128px is the smallest of the three).
        expect(h[0]).toBeLessThan(h[1]);
        expect(h[1]).toBeLessThan(h[2]);
        expect(h[2]).toBeGreaterThan(64);
      }
    } finally {
      await browser.close();
    }
  }, 60_000);
});
