/**
 * The visual builder against the REAL stack (playwright.editor-live.config.ts): real admin, real
 * storefront in the canvas iframe, real API in workerd, real Postgres seeded with Dahab.
 *
 *   edit a hero heading  -> the canvas shows it live (same document, no reload) and it autosaves
 *   add + reorder        -> the canvas renders the new section, in the new order
 *   change a setting     -> hiding a section removes it from the canvas
 *   publish              -> the public storefront serves the published page
 *
 * Phase 2 only ever ran against a stand-in API and a fake canvas page; the integration (preview
 * token -> storefront server render of the draft -> overlay handshake over postMessage between the
 * two real origins) was never exercised, which is how a canvas that never became interactive
 * reached the hosted preview.
 */
import { test, expect, type Page, type BrowserContext, type Frame } from '@playwright/test';

const STORE_ORIGIN = 'https://dahab-preview.ebda.app'; // the seeded store's real origin
const OWNER = {
  email: 'dahab-demo@ebda.app',
  password: process.env.EDITOR_E2E_OWNER_PW || 'Editor-e2e#2026',
};
const HEADLINE = `عنوان تجريبي ${Date.now() % 100000}`;

/** Serve the store's real https origin from the local storefront (Host header kept). */
async function routeStorefront(context: BrowserContext) {
  const webPort = test.info().config.metadata.webPort as number;
  await context.route(new RegExp(`^${STORE_ORIGIN.replace(/\./g, '\\.')}/`), async route => {
    const u = new URL(route.request().url());
    try {
      const response = await route.fetch({
        url: `http://127.0.0.1:${webPort}${u.pathname}${u.search}`,
        headers: { ...route.request().headers(), host: u.host },
        maxRedirects: 0,
      });
      await route.fulfill({ response });
    } catch {
      // the page closed while this fetch was in flight (end of a test): nothing left to serve
    }
  });
}

async function login(page: Page) {
  await page
    .context()
    .addCookies([{ name: 'admin-lang', value: 'ar', url: test.info().project.use.baseURL! }]);
  await page.goto('/login');
  // the form re-mounts once the auth state resolves: retry until the login navigates away
  await expect(async () => {
    if (new URL(page.url()).pathname.startsWith('/login')) {
      await page.fill('#email', OWNER.email, { timeout: 2_000 });
      await page.fill('#password', OWNER.password, { timeout: 2_000 });
      await page.locator('#password').press('Enter', { timeout: 2_000 });
    }
    await page.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 5_000 });
  }).toPass({ timeout: 90_000 });
}

async function storeId(page: Page): Promise<string> {
  const apiUrl = test.info().config.metadata.apiUrl as string;
  const token = await page.evaluate(() => localStorage.getItem('accessToken'));
  const r = await page.request.get(`${apiUrl}/api/v1/admin/stores`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const body = await r.json();
  const stores = (body.data?.stores ?? body.data) as Array<{ id: string; slug: string }>;
  return stores.find(s => s.slug === 'dahab-preview')!.id;
}

/** The canvas frame once the storefront's editor overlay has said `ready`. */
async function openBuilder(page: Page): Promise<Frame> {
  await routeStorefront(page.context());
  await login(page);
  const id = await storeId(page);
  await page.goto(`/stores/${id}/builder`);
  await expect(page.getByTestId('builder')).toBeVisible({ timeout: 60_000 });
  const iframe = page.getByTestId('builder-canvas');
  await expect(iframe).toHaveAttribute(
    'src',
    new RegExp(`^${STORE_ORIGIN}/\\?_preview=\\d+&_builder=`)
  );
  // `ready` arrived from the real storefront origin: the editor drops its loading notice
  await expect(page.locator('[role="status"]', { hasText: /تحميل|Loading/ })).toHaveCount(0, {
    timeout: 90_000,
  });
  const frame = page.frames().find(f => f.url().startsWith(`${STORE_ORIGIN}/`))!;
  // the server rendered the DRAFT through the builder shell (section markers), not the public page
  await expect(frame.locator('[data-builder-id="hero"]')).toBeVisible();
  return frame;
}

const sectionOrder = (frame: Frame) =>
  frame
    .locator('[data-builder-id]')
    .evaluateAll(els =>
      els
        .filter(e => !e.parentElement?.closest('[data-builder-id]'))
        .map(e => e.getAttribute('data-builder-id')!)
    );
const templateIds = (page: Page) =>
  page
    .getByTestId('tree-group-template')
    .locator('[data-testid^="tree-row-"]')
    .evaluateAll(els => els.map(e => e.getAttribute('data-testid')!.replace('tree-row-', '')));
const waitSaved = (page: Page) =>
  expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', {
    timeout: 30_000,
  });

test.describe.serial('visual builder on the real stack', () => {
  test('editing a hero heading updates the live canvas without a reload, and autosaves', async ({
    page,
  }) => {
    const frame = await openBuilder(page);
    await frame.evaluate(() => ((window as unknown as { __sameDoc: number }).__sameDoc = 1));
    const firstSlide = page.locator('[data-testid^="tree-block-hero-"]').first();
    await firstSlide.click();
    await page.getByTestId('field-headlineAr').fill(HEADLINE);
    await expect(frame.locator('[data-builder-id="hero"]')).toContainText(HEADLINE);
    // same document: the edit arrived over postMessage, not by reloading the iframe
    expect(
      await frame.evaluate(() => (window as unknown as { __sameDoc?: number }).__sameDoc)
    ).toBe(1);
    await waitSaved(page);
    // the draft really persisted: a fresh editor session renders it in a fresh canvas
    const again = await openBuilder(page);
    await expect(again.locator('[data-builder-id="hero"]')).toContainText(HEADLINE);
  });

  test('adding and reordering a section renders in the canvas in the new order', async ({
    page,
  }) => {
    const frame = await openBuilder(page);
    const before = await templateIds(page);
    await page.getByTestId('add-section-template').click();
    await page.getByTestId('preset-image-text-0').click();
    await expect.poll(async () => (await templateIds(page)).length).toBe(before.length + 1);
    const added = (await templateIds(page)).find(id => !before.includes(id))!;
    await expect(frame.locator(`[data-builder-id="${added}"]`)).toBeAttached();

    const at = (await sectionOrder(frame)).indexOf(added);
    await page.getByTestId(`tree-select-${added}`).press('Alt+ArrowUp');
    await expect.poll(async () => (await sectionOrder(frame)).indexOf(added)).toBe(at - 1);
    await waitSaved(page);
  });

  test('changing a setting (hide a section) takes it off the canvas', async ({ page }) => {
    const frame = await openBuilder(page);
    // a section that renders something right now (the seed's ids are generated)
    let target = '';
    for (const id of (await templateIds(page)).reverse()) {
      const el = frame.locator(`[data-builder-id="${id}"]`);
      if ((await el.count()) === 1 && (await el.innerText()).trim()) {
        target = id;
        break;
      }
    }
    expect(target).not.toBe('');
    await page
      .getByTestId(`tree-row-${target}`)
      .getByRole('button', { name: /^إخفاء / })
      .click();
    // a hidden section renders nothing (a legacy-backed one keeps an empty marker)
    const marker = frame.locator(`[data-builder-id="${target}"]`);
    await expect
      .poll(async () => ((await marker.count()) === 0 ? '' : (await marker.innerText()).trim()))
      .toBe('');
    await waitSaved(page);
  });

  test('publish: the public storefront serves the published page', async ({ page, context }) => {
    await openBuilder(page);
    await page.getByTestId('publish-open').click();
    await page.getByTestId('publish').click();
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', {
      timeout: 30_000,
    });
    const shop = await context.newPage();
    // the storefront's committed-layout fetch is cached for 60 s (purged on publish where the
    // revalidate binding exists); poll past that window
    await expect
      .poll(
        async () => {
          await shop.goto(`${STORE_ORIGIN}/`, { waitUntil: 'domcontentloaded' });
          return shop.locator('main').innerText();
        },
        { timeout: 120_000, intervals: [2_000, 5_000, 10_000] }
      )
      .toContain(HEADLINE);
    // the public page is not the editor: no section markers, no overlay
    await expect(shop.locator('[data-builder-id]')).toHaveCount(0);
  });
});
