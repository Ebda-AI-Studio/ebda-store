/**
 * Touch: first tap selects, SECOND tap starts inline editing, on EVERY inline-editable text of every
 * template's home page, at 390 and 820, in the REAL canvas (real admin, real storefront in the
 * iframe, real API), with touch emulation (`hasTouch`, a real `touchscreen.tap`, not `click`).
 *
 * Found on the Dahab `craft` heading: at 1280 click-click edits, at 390 the second tap did not. A
 * failure records what was under the finger (`elementFromPoint`), whether the first tap moved the
 * text, and whether a mouse double-click edits it at all, so a "this text is not inline-editable"
 * case is told apart from a touch bug.
 *
 * Needs the five demo showrooms (`scripts/storedemo/seed.mjs --template <t>`) owned by the editor
 * login: `TOUCH_E2E=1 npm run test:editor-live -- touch-second-tap`.
 */
import { test, expect, type Page, type BrowserContext, type Frame } from '@playwright/test';

const OWNER = {
  email: 'dahab-demo@ebda.app',
  password: process.env.EDITOR_E2E_OWNER_PW || 'Editor-e2e#2026',
};
const SLUGS = (
  process.env.TOUCH_STORES ||
  'dahab-preview,storedemo,storedemo-souq,storedemo-jasmine,storedemo-lamma,storedemo-dahab'
).split(',');
const PAGES = (process.env.TOUCH_PAGES || 'home,collection,product,cart').split(',');
const WIDTHS = (process.env.TOUCH_WIDTHS || '390,820').split(',').map(Number);

test.skip(!process.env.TOUCH_E2E, 'needs the five demo showrooms on the local stack (TOUCH_E2E=1)');

async function routeStorefront(context: BrowserContext) {
  const webPort = test.info().config.metadata.webPort as number;
  await context.route(/^https:\/\/[a-z0-9-]+\.ebda\.app\//, async route => {
    const u = new URL(route.request().url());
    try {
      const response = await route.fetch({
        url: `http://127.0.0.1:${webPort}${u.pathname}${u.search}`,
        headers: { ...route.request().headers(), host: u.host },
        maxRedirects: 0,
      });
      await route.fulfill({ response });
    } catch {
      // page closed with this fetch in flight
    }
  });
}

let session: {
  cookies: Awaited<ReturnType<BrowserContext['cookies']>>;
  local: Record<string, string>;
} | null = null;
async function login(page: Page) {
  const base = test.info().project.use.baseURL!;
  await page.context().addCookies([{ name: 'admin-lang', value: 'ar', url: base }]);
  if (session) {
    await page.context().addCookies(session.cookies.filter(c => c.name !== 'admin-lang'));
    await page.addInitScript(e => {
      for (const [k, v] of Object.entries(e)) localStorage.setItem(k, v);
    }, session.local);
    await page.goto('/');
    return;
  }
  await page.goto('/login');
  await expect(async () => {
    if (new URL(page.url()).pathname.startsWith('/login')) {
      await page.fill('#email', OWNER.email, { timeout: 2_000 });
      await page.fill('#password', OWNER.password, { timeout: 2_000 });
      await page.locator('#password').press('Enter', { timeout: 2_000 });
    }
    await page.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 5_000 });
  }).toPass({ timeout: 90_000 });
  session = {
    cookies: await page.context().cookies(),
    local: await page.evaluate(() => Object.fromEntries(Object.entries(localStorage))),
  };
}

async function storeIds(page: Page): Promise<Record<string, string>> {
  const apiUrl = test.info().config.metadata.apiUrl as string;
  const token = (await page.evaluate(() => localStorage.getItem('accessToken'))) ?? '';
  const r = await page.request.get(`${apiUrl}/api/v1/admin/stores`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const body = await r.json();
  const stores = (body.data?.stores ?? body.data) as Array<{ id: string; slug: string }>;
  return Object.fromEntries(stores.map(s => [s.slug, s.id]));
}

async function openBuilder(page: Page, id: string, pageKey = 'home'): Promise<Frame> {
  // the local API throttles `/store/resolve` to 30 a minute per IP: a busy canvas waits and retries
  for (let attempt = 0; attempt < 6; attempt++) {
    await page.goto(`/stores/${id}/builder${pageKey === 'home' ? '' : `?page=${pageKey}`}`);
    await expect(page.getByTestId('builder')).toBeVisible({ timeout: 60_000 });
    const iframe = page.getByTestId('builder-canvas');
    const origin = new URL((await iframe.getAttribute('src'))!).origin;
    const ready = await expect(page.locator('[role="status"]', { hasText: /تحميل|Loading/ }))
      .toHaveCount(0, { timeout: 45_000 })
      .then(() => true)
      .catch(() => false);
    const frame = page.frames().find(f => f.url().startsWith(`${origin}/`));
    if (ready && frame && (await frame.locator('[data-builder-id]').count()) > 0) return frame;
    await page.waitForTimeout(25_000);
  }
  throw new Error('the canvas never became ready (rate limit?)');
}

/** Nothing selected: the tree's "page settings" row, through the structure drawer on a phone. */
async function deselect(page: Page) {
  const row = page.getByTestId('open-page-settings');
  if (!(await row.isVisible()))
    await page.getByRole('button', { name: 'الهيكل', exact: true }).click();
  await row.click(); // below lg this opens the page-settings drawer over the canvas
  await page.waitForTimeout(300);
  if (await page.getByTestId('page-settings-panel').isVisible()) {
    await page.keyboard.press('Escape'); // a drawer over the canvas would take the next tap
    await page.waitForTimeout(300);
  }
}

const templateIds = (page: Page) =>
  page
    .getByTestId('tree-group-template')
    .locator('[data-testid^="tree-row-"]')
    .evaluateAll(els => els.map(e => e.getAttribute('data-testid')!.replace('tree-row-', '')));
const openTree = async (page: Page) => {
  if (!(await page.getByTestId('add-section-template').isVisible()))
    await page.getByRole('button', { name: 'الهيكل', exact: true }).click();
};

/**
 * The default product / collection / cart document is the pinned core and nothing with text of its
 * own, so a merchant's first text on those pages is an "image + text" section they add. The matrix
 * adds one (and takes it out again) so the second tap is exercised on those pages too.
 */
async function addTextSection(page: Page): Promise<string | null> {
  await openTree(page);
  const before = await templateIds(page);
  await page.getByTestId('add-section-template').click();
  const preset = page.getByTestId('preset-image-text-0');
  if (!(await preset.isEnabled().catch(() => false))) {
    await page.keyboard.press('Escape');
    return null;
  }
  await preset.click();
  await expect.poll(async () => (await templateIds(page)).length).toBe(before.length + 1);
  const added = (await templateIds(page)).find(x => !before.includes(x)) ?? null;
  await page.keyboard.press('Escape'); // closes the structure drawer below lg
  await page.waitForTimeout(600);
  return added;
}
async function removeSection(page: Page, id: string) {
  await openTree(page);
  const row = page.getByTestId(`tree-row-${id}`);
  await row
    .getByRole('button', { name: /^(حذف|Remove)/ })
    .first()
    .click();
  await expect(row).toHaveCount(0);
  await expect(page.getByTestId('save-status'))
    .toHaveAttribute('data-state', 'saved', {
      timeout: 30_000,
    })
    .catch(() => {}); // the status chip is hidden on a phone: the autosave debounce is enough
  await page.waitForTimeout(2_500);
}

interface Node {
  section: string;
  idx: number; // index among [data-builder-setting] in document order
  key: string;
  text: string;
}

/** One finding per text node that did not enter editing on tap. */
interface Finding {
  store: string;
  width: number;
  node: Node;
  taps: number;
  mouseDblClickEdits: boolean;
  diag: unknown;
}

for (const width of WIDTHS) {
  test.describe(`touch second tap, ${width}`, () => {
    test.use({
      viewport: { width, height: width === 390 ? 844 : 1180 },
      hasTouch: true,
      locale: 'ar-EG',
    });
    test.afterEach(async ({ page }) => {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    });

    for (const pageKey of PAGES)
      for (const slug of SLUGS) {
        test(`${slug} ${pageKey}: every inline text edits on the second tap`, async ({ page }) => {
          test.setTimeout(900_000);
          await routeStorefront(page.context());
          await login(page);
          const ids = await storeIds(page);
          const id = ids[slug];
          expect(id, `store ${slug} owned by the editor login`).toBeTruthy();
          let frame = await openBuilder(page, id, pageKey);

          page.setDefaultTimeout(5_000); // a hidden or re-rendered node must fail fast, not wait 30 s
          let addedSection: string | null = null;
          if (pageKey !== 'home') addedSection = await addTextSection(page);
          if (addedSection) await page.waitForTimeout(800);
          const nodes: Node[] = await frame.evaluate(() =>
            [...document.querySelectorAll<HTMLElement>('[data-builder-setting]')]
              .map((el, idx) => ({
                section: el.closest('[data-builder-id]')?.getAttribute('data-builder-id') ?? '',
                idx,
                key: el.getAttribute('data-builder-setting')!,
                text: (el.textContent ?? '').trim().slice(0, 40),
              }))
              .filter(n => n.section && n.text)
          );
          if (nodes.length === 0) {
            if (addedSection) await removeSection(page, addedSection);
            // a page whose canvas has no inline text (the pinned core of a cart / product): nothing to tap
            console.log(`MATRIX ${slug}/${pageKey}@${width}: no inline text on this page`);
            return;
          }

          const findings: Finding[] = [];
          let tested = 0;
          let skipped = 0;
          const bySection = new Map<string, Node[]>();
          for (const n of nodes) bySection.set(n.section, [...(bySection.get(n.section) ?? []), n]);

          await frame.evaluate(() => {
            const w = window as unknown as { __lastClick?: unknown };
            window.addEventListener(
              'click',
              e => {
                const t = e.target as HTMLElement;
                w.__lastClick = {
                  tag: t.tagName,
                  key:
                    t.closest('[data-builder-setting]')?.getAttribute('data-builder-setting') ??
                    null,
                  section: t.closest('[data-builder-id]')?.getAttribute('data-builder-id') ?? null,
                };
              },
              true
            );
          });

          /** The node's centre as a PAGE point. The admin scales the iframe (transform), and Playwright's
           *  own `boundingBox` / `click` ignore that scale for content inside a frame: they aim low. */
          const place = async (idx: number) => {
            const g = await frame.evaluate(i => {
              const e = document.querySelectorAll<HTMLElement>('[data-builder-setting]')[i];
              if (!e) return null;
              const cs = getComputedStyle(e);
              if (cs.visibility === 'hidden' || cs.display === 'none') return null;
              e.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
              const r = e.getBoundingClientRect();
              if (r.width <= 2 || r.height <= 2) return null;
              return {
                fx: r.left + r.width / 2,
                fy: r.top + Math.min(r.height / 2, 24),
                iw: window.innerWidth,
              };
            }, idx);
            const ifr = await page.getByTestId('builder-canvas').boundingBox();
            if (!g || !ifr) return null;
            const sc = ifr.width / g.iw;
            return { x: ifr.x + g.fx * sc, y: ifr.y + g.fy * sc, scale: sc };
          };
          const editing = (idx: number) =>
            frame.evaluate(i => {
              const e = document.querySelectorAll<HTMLElement>('[data-builder-setting]')[i];
              return (
                !!e &&
                e.hasAttribute('contenteditable') &&
                e.getAttribute('contenteditable') !== 'false'
              );
            }, idx);

          for (const [, list] of bySection) {
            await deselect(page); // nothing selected
            for (const n of list) {
              if (!(await place(n.idx))) {
                skipped++;
                continue;
              }
              let taps = 0;
              let landed: unknown = null;
              let covered: unknown = null;
              const tap = async () => {
                const p = (await place(n.idx))!; // re-aim: the first tap's selection may scroll
                covered = await page.evaluate(pt => {
                  const h = document.elementFromPoint(pt.x, pt.y);
                  return h?.getAttribute('data-testid') === 'builder-canvas'
                    ? null
                    : `${h?.tagName}.${String(h?.className).slice(0, 50)}`;
                }, p);
                await page.touchscreen.tap(p.x, p.y);
                taps++;
                await page.waitForTimeout(350);
                landed = await frame.evaluate(
                  () => (window as unknown as { __lastClick?: unknown }).__lastClick
                );
              };
              await tap();
              if (!(await editing(n.idx))) await tap();
              if (!(await editing(n.idx))) {
                const p = (await place(n.idx))!;
                await page.keyboard.press('Escape');
                await page.mouse.dblclick(p.x, p.y);
                await page.waitForTimeout(300);
                findings.push({
                  store: slug,
                  width,
                  node: n,
                  taps,
                  mouseDblClickEdits: await editing(n.idx),
                  diag: { landed, coveredByAdmin: covered, scale: p.scale },
                });
              }
              tested++;
              await page.keyboard.press('Escape');
              await page.waitForTimeout(150);
            }
          }
          test.info().annotations.push({
            type: 'tested',
            description: `${slug}@${width}: ${tested} tested, ${skipped} hidden`,
          });
          console.log(
            `MATRIX ${slug}/${pageKey}@${width}: ${tested} tested, ${skipped} hidden, ${findings.length} failed`
          );
          for (const f of findings) console.log('FINDING ' + JSON.stringify(f));
          if (addedSection) await removeSection(page, addedSection);
          expect(findings, JSON.stringify(findings, null, 1)).toEqual([]);
        });
      }
  });
}
