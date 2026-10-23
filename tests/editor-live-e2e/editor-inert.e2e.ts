/**
 * In the builder canvas NO storefront action may run. Every distinct interactive element of the
 * home, collection (PLP), product (PDP) and cart pages of every template is clicked / tapped in the
 * REAL canvas (real admin, real storefront in the iframe, real API) and nothing may happen:
 *
 *   - no non-GET request starts from the canvas frame (cart, wishlist, orders, coupon, newsletter,
 *     search, checkout ... one rule, not a list),
 *   - the canvas keeps its URL (no link, no router.push, no window.location, no window.open),
 *   - no dialog / cart drawer opens, and focus is not moved anywhere the click did not put it,
 *   - Enter in a text field submits nothing, and changing a select / checkbox does nothing.
 *
 * DECISION (documented in docs/architecture/visual-editor.md): the canvas is inert, selection UI
 * included. A variant swatch or a tab does not switch in the canvas: those handlers are React
 * `onClick`s and cannot be told apart from "add to cart" without per-component knowledge, which is
 * the per-component patching this layer exists to avoid. Native `<details>` still toggles.
 *
 *   INERT_E2E=1 npm run test:editor-live -- editor-inert
 */
import { test, expect, type Page, type BrowserContext, type Frame } from '@playwright/test';

const OWNER = {
  email: 'dahab-demo@ebda.app',
  password: process.env.EDITOR_E2E_OWNER_PW || 'Editor-e2e#2026',
};
const SLUGS = (
  process.env.INERT_STORES ||
  'dahab-preview,storedemo,storedemo-souq,storedemo-jasmine,storedemo-lamma,storedemo-dahab'
).split(',');
const PAGES = (process.env.INERT_PAGES || 'home,collection,product,cart').split(',');
const SCENARIOS = [
  { name: 'ar-390-touch', lang: 'ar', width: 390, height: 844, touch: true },
  { name: 'en-1280-mouse', lang: 'en', width: 1280, height: 900, touch: false },
].filter(s => (process.env.INERT_SCENARIOS || 'ar-390-touch,en-1280-mouse').includes(s.name));
const MAX_PER_SIGNATURE = 2;

test.skip(!process.env.INERT_E2E, 'needs the demo showrooms on the local stack (INERT_E2E=1)');

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
async function login(page: Page, lang: string) {
  const base = test.info().project.use.baseURL!;
  await page.context().addCookies([{ name: 'admin-lang', value: lang, url: base }]);
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

async function openBuilder(page: Page, id: string, pageKey: string): Promise<Frame> {
  // the local API throttles `/store/resolve` to 30 a minute per IP: a busy canvas waits and retries
  for (let attempt = 0; attempt < 6; attempt++) {
    await page.goto(`/stores/${id}/builder${pageKey === 'home' ? '' : `?page=${pageKey}`}`);
    await expect(page.getByTestId('builder')).toBeVisible({ timeout: 60_000 });
    const iframe = page.getByTestId('builder-canvas');
    await expect(iframe).toHaveAttribute('src', /.+/, { timeout: 30_000 });
    const origin = new URL((await iframe.getAttribute('src'))!).origin;
    const ready = await expect(page.locator('[role="status"]', { hasText: /تحميل|Loading/ }))
      .toHaveCount(0, { timeout: 45_000 })
      .then(() => true)
      .catch(() => false);
    const frame = page.frames().find(f => f.url().startsWith(`${origin}/`));
    if (ready && frame && (await frame.locator('[data-builder-id], main').count()) > 0) {
      await page.waitForTimeout(1_500); // hydration + the overlay's own mount
      return frame;
    }
    await page.waitForTimeout(25_000);
  }
  throw new Error('the canvas never became ready (rate limit?)');
}

/** The interactive things a shopper can press, minus the overlay's own controls. */
const INTERACTIVE =
  'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=switch]';

interface Target {
  sig: string;
  nth: number; // occurrence of this signature, in document order
  label: string;
}

for (const sc of SCENARIOS) {
  for (const pageKey of PAGES) {
    test.describe(`canvas is inert: ${pageKey}, ${sc.name}`, () => {
      test.use({
        viewport: { width: sc.width, height: sc.height },
        hasTouch: sc.touch,
        locale: sc.lang === 'ar' ? 'ar-EG' : 'en-US',
      });
      test.afterEach(async ({ page }) => {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
      });

      for (const slug of SLUGS) {
        test(`${slug}`, async ({ page }) => {
          test.setTimeout(900_000);
          await routeStorefront(page.context());
          await login(page, sc.lang);
          const id = (await storeIds(page))[slug];
          expect(id, `store ${slug} owned by the editor login`).toBeTruthy();
          let frame = await openBuilder(page, id, pageKey);
          page.setDefaultTimeout(5_000);

          // every non-GET the canvas starts, whatever it is (the admin's own saves are not the canvas')
          const mutations: string[] = [];
          page.on('request', r => {
            if (['GET', 'HEAD', 'OPTIONS'].includes(r.method())) return;
            if (r.frame() === frame) mutations.push(`${r.method()} ${r.url()}`);
          });
          const stub = () =>
            frame.evaluate(() => {
              const w = window as unknown as { __opened?: number; open: typeof window.open };
              if (w.__opened === undefined) {
                w.__opened = 0;
                w.open = () => {
                  w.__opened = (w.__opened ?? 0) + 1;
                  return null;
                };
              }
            });
          await stub();

          // idle: autoplay (hero, carousels) must not move focus
          await page.waitForTimeout(3_000);
          const idleFocus = await frame.evaluate(() => document.activeElement?.tagName);
          expect(['BODY', 'HTML', undefined], 'autoplay stole focus').toContain(idleFocus);

          const targets: Target[] = await frame.evaluate(
            ([sel, max]) => {
              const own =
                '[data-builder-toolbar-root], [data-builder-insert], [data-builder-change-image]';
              const seen = new Map<string, number>();
              const out: Array<{ sig: string; nth: number; label: string }> = [];
              const hrefKind = (a: HTMLAnchorElement) => {
                const h = a.getAttribute('href') ?? '';
                if (h.startsWith('#')) return '#';
                if (/^(mailto|tel):/.test(h)) return h.split(':')[0];
                if (/^https?:\/\//.test(h) && !h.includes(location.host)) return 'external';
                return '/' + (h.replace(/^https?:\/\/[^/]+/, '').split('/')[1] ?? '').split('?')[0];
              };
              document.querySelectorAll<HTMLElement>(sel).forEach(e => {
                if (e.closest(own)) return;
                if ((e as HTMLButtonElement).disabled) return;
                const r = e.getBoundingClientRect();
                const cs = getComputedStyle(e);
                if (
                  r.width < 2 ||
                  r.height < 2 ||
                  cs.visibility === 'hidden' ||
                  cs.display === 'none'
                )
                  return;
                const tag = e.tagName.toLowerCase();
                const type = (e as HTMLInputElement).type ?? '';
                const text = (e.getAttribute('aria-label') || e.textContent || '')
                  .trim()
                  .slice(0, 24);
                const sig =
                  tag === 'a'
                    ? `a|${hrefKind(e as HTMLAnchorElement)}`
                    : tag === 'input'
                      ? `input|${type}|${(e as HTMLInputElement).name}`
                      : `${tag}|${e.getAttribute('role') ?? ''}|${type}|${text}`;
                const n = seen.get(sig) ?? 0;
                seen.set(sig, n + 1);
                if (n < max) out.push({ sig, nth: n, label: `${sig} "${text}"` });
              });
              return out;
            },
            [INTERACTIVE, MAX_PER_SIGNATURE] as const
          );
          expect(targets.length, 'interactive elements on the page').toBeGreaterThan(0);

          const aim = async (t: Target) => {
            const g = await frame.evaluate(
              ([sel, sig, nth]) => {
                const own =
                  '[data-builder-toolbar-root], [data-builder-insert], [data-builder-change-image]';
                const hrefKind = (a: HTMLAnchorElement) => {
                  const h = a.getAttribute('href') ?? '';
                  if (h.startsWith('#')) return '#';
                  if (/^(mailto|tel):/.test(h)) return h.split(':')[0];
                  if (/^https?:\/\//.test(h) && !h.includes(location.host)) return 'external';
                  return (
                    '/' + (h.replace(/^https?:\/\/[^/]+/, '').split('/')[1] ?? '').split('?')[0]
                  );
                };
                let k = 0;
                for (const e of document.querySelectorAll<HTMLElement>(sel)) {
                  if (e.closest(own) || (e as HTMLButtonElement).disabled) continue;
                  const r0 = e.getBoundingClientRect();
                  const cs = getComputedStyle(e);
                  if (
                    r0.width < 2 ||
                    r0.height < 2 ||
                    cs.visibility === 'hidden' ||
                    cs.display === 'none'
                  )
                    continue;
                  const tag = e.tagName.toLowerCase();
                  const type = (e as HTMLInputElement).type ?? '';
                  const text = (e.getAttribute('aria-label') || e.textContent || '')
                    .trim()
                    .slice(0, 24);
                  const s =
                    tag === 'a'
                      ? `a|${hrefKind(e as HTMLAnchorElement)}`
                      : tag === 'input'
                        ? `input|${type}|${(e as HTMLInputElement).name}`
                        : `${tag}|${e.getAttribute('role') ?? ''}|${type}|${text}`;
                  if (s !== sig) continue;
                  if (k++ !== nth) continue;
                  e.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
                  const r = e.getBoundingClientRect();
                  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                  return {
                    fx: r.left + r.width / 2,
                    fy: r.top + Math.min(r.height / 2, 24),
                    iw: window.innerWidth,
                    covered: !!top && !(e.contains(top) || top.contains(e)),
                    isText: tag === 'input' || tag === 'textarea',
                    isSelect: tag === 'select',
                  };
                }
                return null;
              },
              [INTERACTIVE, t.sig, t.nth] as const
            );
            const ifr = await page.getByTestId('builder-canvas').boundingBox();
            if (!g || !ifr) return null;
            const sc2 = ifr.width / g.iw; // the admin scales the iframe; Playwright's frame boxes ignore it
            return { x: ifr.x + g.fx * sc2, y: ifr.y + g.fy * sc2, ...g };
          };

          const navLog: string[] = [];
          page.on('framenavigated', f =>
            navLog.push(`${f === frame ? 'canvas' : 'other'} ${f.url().slice(0, 120)}`)
          );
          const failures: string[] = [];
          // the canvas' own address without the admin's reload counter and token
          const frameUrl = () => {
            const u = new URL(frame.url());
            u.searchParams.delete('_preview');
            u.searchParams.delete('_builder');
            return u.pathname + u.search;
          };
          const refind = async () => {
            // the admin re-creates the iframe after a saved-data change: a NEW frame, same address
            const origin = new URL((await page.getByTestId('builder-canvas').getAttribute('src'))!)
              .origin;
            const f = page.frames().find(x => x.url().startsWith(`${origin}/`));
            if (f && f !== frame) {
              frame = f;
              await page.waitForTimeout(1_500);
              await stub();
              return true;
            }
            return false;
          };
          let startUrl = frameUrl();
          const startPage = page.url();
          let tried = 0;
          for (const t of targets) {
            const a = await aim(t).catch(() => null);
            if (!a || a.covered) continue; // not reachable by a finger (under a sticky bar): not a click
            tried++;
            mutations.length = 0;
            navLog.length = 0;
            if (sc.touch) await page.touchscreen.tap(a.x, a.y);
            else await page.mouse.click(a.x, a.y);
            await page.waitForTimeout(250);
            if (a.isText) {
              await page.keyboard.type('x');
              await page.keyboard.press('Enter');
              await page.waitForTimeout(250);
            }
            if (a.isSelect) {
              // a sort / filter select must not navigate or fetch when its value changes
              await frame.evaluate(() => {
                const el = document.activeElement;
                if (el instanceof HTMLSelectElement && el.options.length > 1) {
                  el.selectedIndex = el.options.length - 1;
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                }
              });
              await page.waitForTimeout(400);
            }
            const problems: string[] = [];
            if (mutations.length) problems.push(`requests: ${[...new Set(mutations)].join(', ')}`);
            if (frame.isDetached()) await refind();
            const cur = await frame
              .evaluate(() => {
                const u = new URL(location.href);
                u.searchParams.delete('_preview');
                u.searchParams.delete('_builder');
                return u.pathname + u.search;
              })
              .catch(() => 'GONE');
            if (cur !== startUrl) problems.push(`canvas navigated to ${cur}`);
            if (page.url() !== startPage) problems.push(`admin navigated to ${page.url()}`);
            const state = await frame
              .evaluate(() => ({
                opened: (window as unknown as { __opened?: number }).__opened ?? 0,
                dialogs: [
                  ...document.querySelectorAll('[role=dialog], [aria-modal=true], dialog[open]'),
                ].filter(d => (d as HTMLElement).getBoundingClientRect().width > 0).length,
              }))
              .catch(() => null);
            if (!state) problems.push(`canvas frame gone; navigations: ${navLog.join(' | ')}`);
            else {
              if (state.opened) problems.push('window.open called');
              if (state.dialogs) problems.push(`${state.dialogs} dialog(s) opened`);
            }
            if (problems.length) {
              failures.push(`${t.label}: ${problems.join('; ')}`);
              if (cur !== startUrl || !state) {
                frame = await openBuilder(page, id, pageKey);
                startUrl = frameUrl();
                await stub();
              }
            }
            await page.keyboard.press('Escape');
          }
          console.log(
            `INERT ${slug} ${pageKey} ${sc.name}: ${tried}/${targets.length} pressed, ${failures.length} failed`
          );
          for (const f of failures) console.log('FAIL ' + f);
          expect(failures).toEqual([]);
        });
      }
    });
  }
}
