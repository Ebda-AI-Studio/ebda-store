/**
 * Store story (id=story on /store/, formerly the home page), Ruling MKT-STORY-1: pinned, scrolled by progress (--p), compositor-only. Measured in Chrome:
 * no long task (>50 ms) while scrolling, no frame over 34 ms, CLS 0, keyboard (space bar) scrolling drives it,
 * and reduced motion gets the static finished store.
 */
import { test, expect } from '@playwright/test';

// On-demand audit (not in CI): frame timing is machine-dependent, so a noisy machine gets two retries.
test.describe.configure({ retries: 2 });

const SIZES = [
  { w: 1280, h: 800 },
  { w: 1440, h: 900 },
  { w: 390, h: 844 },
];

for (const { w, h } of SIZES) {
  test(`story scrub ${w}px: no long task, no dropped frame, CLS 0, --p reaches 1`, async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      const win = window as unknown as Record<string, unknown>;
      win.__long = [];
      win.__cls = [] as number[][];
      new PerformanceObserver(l =>
        l.getEntries().forEach(e => (win.__long as number[][]).push([e.startTime, e.duration]))
      ).observe({ type: 'longtask', buffered: true });
      new PerformanceObserver(l =>
        l.getEntries().forEach(e => {
          const ls = e as unknown as { hadRecentInput: boolean; value: number };
          if (!ls.hadRecentInput) (win.__cls as number[][]).push([e.startTime, ls.value]);
        })
      ).observe({ type: 'layout-shift', buffered: true });
    });
    await page.goto('/store/', { waitUntil: 'load' });
    // let hydration, fonts and the 3D viewer settle: page-load work is the page's, not the story's
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(3000);
    const total = await page.evaluate(() => {
      const s = document.getElementById('story')!;
      window.scrollTo({ top: s.getBoundingClientRect().top + scrollY - 10, behavior: 'instant' });
      const win = window as unknown as Record<string, unknown>;
      win.__t0 = performance.now();
      win.__gaps = [] as number[];
      let last = performance.now();
      const tick = (t: number) => {
        (win.__gaps as number[]).push(t - last);
        last = t;
        win.__raf = requestAnimationFrame(tick);
      };
      win.__raf = requestAnimationFrame(tick);
      return s.offsetHeight - innerHeight;
    });
    await page.mouse.move(w / 2, h / 2);
    const readP = () =>
      page.evaluate(() =>
        Number(getComputedStyle(document.getElementById('story')!).getPropertyValue('--p'))
      );
    for (let i = 0; i < Math.ceil(total / 100) * 3 && (await readP()) < 1; i++) {
      await page.mouse.wheel(0, 100);
      await page.waitForTimeout(16);
    }
    // smooth-wheel scrolling keeps animating after the last tick: wait for the end of the story
    await page
      .waitForFunction(
        () =>
          Number(getComputedStyle(document.getElementById('story')!).getPropertyValue('--p')) >= 1,
        null,
        { timeout: 4000 }
      )
      .catch(() => {});
    const r = await page.evaluate(() => {
      const win = window as unknown as Record<string, unknown>;
      cancelAnimationFrame(win.__raf as number);
      const gaps = (win.__gaps as number[]).slice(3);
      return {
        longDuring: (win.__long as number[][]).filter(x => x[0] >= (win.__t0 as number)),
        // shifts while the story scrolls (page-load font swaps are the page's, not the story's)
        cls: (win.__cls as number[][])
          .filter(x => x[0] >= (win.__t0 as number))
          .reduce((n, x) => n + x[1], 0),
        slow: gaps.filter(g => g > 34).length,
        p: Number(getComputedStyle(document.getElementById('story')!).getPropertyValue('--p')),
      };
    });
    expect(r.longDuring).toEqual([]);
    expect(r.cls).toBe(0);
    expect(r.slow).toBe(0);
    expect(r.p).toBe(1);
    await ctx.close();
  });
}

test('story: the space bar scrolls it (native scroll, no hijack)', async ({ page }) => {
  await page.goto('/store/', { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    const s = document.getElementById('story')!;
    window.scrollTo({ top: s.getBoundingClientRect().top + scrollY - 10, behavior: 'instant' });
  });
  await page.focus('body');
  const seen: number[] = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Space');
    await page.waitForTimeout(450);
    seen.push(
      Number(
        await page.evaluate(() =>
          getComputedStyle(document.getElementById('story')!).getPropertyValue('--p')
        )
      )
    );
  }
  expect(seen[0]).toBeGreaterThan(0);
  expect(seen.at(-1)).toBe(1);
  expect([...seen].sort((a, b) => a - b)).toEqual(seen);
});

test('story: reduced motion shows the finished store in normal flow', async ({ browser }) => {
  const ctx = await browser.newContext({
    reducedMotion: 'reduce',
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();
  await page.goto('/store/', { waitUntil: 'load' });
  const s = await page.evaluate(() => {
    const el = document.getElementById('story')!;
    const cs = getComputedStyle(el);
    return {
      p: cs.getPropertyValue('--p').trim(),
      sticky: getComputedStyle(el.querySelector('.story-sticky')!).position,
      h: el.offsetHeight,
      vh: innerHeight,
      f4: getComputedStyle(el.querySelector('.story-frame[data-f="4"]')!).opacity,
      toast: getComputedStyle(el.querySelector('.story-toast')!).opacity,
    };
  });
  expect(s.p).toBe('1');
  expect(s.sticky).toBe('static');
  expect(s.h).toBeLessThan(s.vh * 2);
  expect(s.f4).toBe('1');
  expect(s.toast).toBe('1');
  await ctx.close();
});

test('story: without JavaScript there is no pinned dead scroll, just the finished store', async ({
  browser,
}) => {
  const ctx = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();
  await page.goto('/store/', { waitUntil: 'load' });
  const s = await page.evaluate(() => {
    const el = document.getElementById('story')!;
    return {
      sticky: getComputedStyle(el.querySelector('.story-sticky')!).position,
      h: el.offsetHeight,
      vh: innerHeight,
      f4: getComputedStyle(el.querySelector('.story-frame[data-f="4"]')!).opacity,
      step1: getComputedStyle(el.querySelector('.story-steps li')!).opacity,
    };
  });
  expect(s.sticky).toBe('static');
  expect(s.h).toBeLessThan(s.vh * 2);
  expect(s.f4).toBe('1');
  expect(s.step1).toBe('1');
  await ctx.close();
});

test('story glide: wheel ticks are smoothed (desktop), the page still ends where the wheel says', async ({
  page,
}) => {
  await page.goto('/store/', { waitUntil: 'load' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    const s = document.getElementById('story')!;
    window.scrollTo({ top: s.getBoundingClientRect().top + scrollY + 50, behavior: 'instant' });
  });
  const y0 = await page.evaluate(() => scrollY);
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, 400);
  // one frame later the scroll has started but not finished: that is the glide
  await page.waitForTimeout(40);
  const mid = await page.evaluate(() => scrollY);
  await page.waitForTimeout(1200);
  const end = await page.evaluate(() => scrollY);
  expect(mid - y0).toBeGreaterThan(0);
  expect(mid - y0).toBeLessThan(400);
  expect(Math.abs(end - y0 - 400)).toBeLessThan(2);
});
