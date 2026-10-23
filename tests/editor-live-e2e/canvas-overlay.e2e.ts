/**
 * The REAL canvas overlay in a REAL browser (plan Task 1 to 4, review P2-1): the storefront's
 * `EditorOverlay` running inside the admin's iframe on the local stack (real admin, real storefront,
 * real API in workerd, real Postgres). The fast suite (`playwright.builder.config.ts`) only has a
 * contract fake of the canvas, and jsdom has no layout, no `innerText` and no `plaintext-only`; this
 * is the spec that can fail on layout, text-transform, caret and pointer drag.
 *
 *   click-select (name chip) -> "+" insert (keyboard) -> inline Arabic edit (typed, then the saved
 *   draft) -> raw text under CSS uppercase -> Escape -> HTML paste lands as text -> change image
 *   opens the admin picker -> drag reorder with the real pointer -> toolbar remove (in-app confirm).
 *
 * No screenshots: every check is an assertion. Run with `npm run test:editor-live`.
 */
import { test, expect, type Page, type BrowserContext, type Frame } from '@playwright/test';

const STORE_ORIGIN = 'https://dahab-preview.ebda.app';
const OWNER = {
  email: 'dahab-demo@ebda.app',
  password: process.env.EDITOR_E2E_OWNER_PW || 'Editor-e2e#2026',
};
const ARABIC = `عنوان مكتوب بالكيبورد ${Date.now() % 100000}`;

// tall window: the canvas is the viewport height, so neighbouring sections are on screen together
test.use({ viewport: { width: 1280, height: 2600 } });

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
  await expect(async () => {
    if (new URL(page.url()).pathname.startsWith('/login')) {
      await page.fill('#email', OWNER.email, { timeout: 2_000 });
      await page.fill('#password', OWNER.password, { timeout: 2_000 });
      await page.locator('#password').press('Enter', { timeout: 2_000 });
    }
    await page.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 5_000 });
  }).toPass({ timeout: 90_000 });
}

async function storeInfo(page: Page): Promise<{ id: string; token: string }> {
  const apiUrl = test.info().config.metadata.apiUrl as string;
  const token = (await page.evaluate(() => localStorage.getItem('accessToken'))) ?? '';
  const r = await page.request.get(`${apiUrl}/api/v1/admin/stores`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const body = await r.json();
  const stores = (body.data?.stores ?? body.data) as Array<{ id: string; slug: string }>;
  return { id: stores.find(s => s.slug === 'dahab-preview')!.id, token };
}

/** The saved DRAFT document, read straight from the API (the source of truth, not the UI). */
async function draft(page: Page, id: string, token: string) {
  const apiUrl = test.info().config.metadata.apiUrl as string;
  const r = await page.request.get(`${apiUrl}/api/v1/admin/stores/${id}/builder/pages/home`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const body = await r.json();
  if (!body.data)
    throw new Error(`draft read failed: ${r.status()} ${JSON.stringify(body).slice(0, 200)}`);
  return body.data.definition as {
    sections: Array<{ id: string; type: string; settings: Record<string, string> }>;
  };
}

async function openBuilder(page: Page): Promise<{ frame: Frame; id: string; token: string }> {
  await routeStorefront(page.context());
  await login(page);
  const { id, token } = await storeInfo(page);
  await page.goto(`/stores/${id}/builder`);
  await expect(page.getByTestId('builder')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[role="status"]', { hasText: /تحميل|Loading/ })).toHaveCount(0, {
    timeout: 90_000,
  });
  const frame = page.frames().find(f => f.url().startsWith(`${STORE_ORIGIN}/`))!;
  await expect(frame.locator('[data-builder-id]').first()).toBeAttached();
  return { frame, id, token };
}

const templateIds = (page: Page) =>
  page
    .getByTestId('tree-group-template')
    .locator('[data-testid^="tree-row-"]')
    .evaluateAll(els => els.map(e => e.getAttribute('data-testid')!.replace('tree-row-', '')));
const box = async (frame: Frame, id: string) => {
  const b = await frame.locator(`[data-builder-id="${id}"] > *`).first().boundingBox();
  if (!b) throw new Error(`no box for ${id}`);
  return b;
};

test('the real overlay: select, insert, type Arabic, raw case, drag, remove', async ({ page }) => {
  test.setTimeout(300_000);
  const { frame, id, token } = await openBuilder(page);
  const before = await templateIds(page);
  expect(before.length).toBeGreaterThan(3);

  // ---- "+" between sections: the keyboard path (focus reveals it), then the admin picker ----
  const plus = frame.locator('[data-builder-insert] button');
  await expect.poll(() => plus.count()).toBeGreaterThan(2);
  await plus.nth(2).focus();
  await expect(frame.locator('[data-builder-insert]:focus-within')).toHaveCSS('opacity', '1');
  await plus.nth(2).press('Enter');
  await expect(page.getByTestId('add-section-dialog')).toBeVisible();
  await page.getByTestId('preset-image-text-0').click();
  await expect.poll(async () => (await templateIds(page)).length).toBe(before.length + 1);
  const order = await templateIds(page);
  const added = order.find(x => !before.includes(x))!;
  const at = order.indexOf(added);
  const prev = order[at - 1];
  expect(at).toBeGreaterThan(0);
  await expect(frame.locator(`[data-builder-id="${added}"]`)).toBeAttached();

  // ---- click-select: the section, with its name chip, in the tree and the panel ----
  await frame.locator(`[data-builder-id="${added}"] > *`).first().click();
  await expect(page.getByTestId(`tree-select-${added}`)).toHaveAttribute('aria-current', 'true');
  await expect(frame.locator('[data-builder-chip="selected"]')).toContainText(
    /صورة مع نص|Image with text/
  );
  await expect(frame.locator('[data-builder-toolbar-root]')).toBeVisible();

  // ---- inline Arabic edit: typed on the canvas, then the SAVED draft ----
  const heading = frame.locator(`[data-builder-id="${added}"] [data-builder-setting]`).first();
  const key = (await heading.getAttribute('data-builder-setting'))!;
  expect(key).toMatch(/^heading/);
  await heading.click(); // already selected: this click edits
  await expect(heading).toHaveAttribute('contenteditable', /.+/);
  await expect(heading).toHaveAttribute('dir', key.endsWith('Ar') ? 'rtl' : 'ltr');
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(ARABIC);
  await page.keyboard.press('Enter');
  await expect(heading).not.toHaveAttribute('contenteditable', /.+/);
  await expect
    .poll(
      async () => (await draft(page, id, token)).sections.find(s => s.id === added)?.settings[key],
      { timeout: 30_000 }
    )
    .toBe(ARABIC);

  // ---- raw text, not painted case: the field is uppercase on screen, the stored text keeps its case ----
  await frame.addStyleTag({
    content: '[data-builder-id] [data-builder-setting]{text-transform:uppercase !important}',
  });
  await heading.click();
  await expect(heading).toHaveCSS('text-transform', 'none'); // editing shows the real characters
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('Mixed Case Title');
  await page.keyboard.press('Enter');
  await expect(heading).toHaveCSS('text-transform', 'uppercase'); // the field's own style is back
  await expect
    .poll(
      async () => (await draft(page, id, token)).sections.find(s => s.id === added)?.settings[key],
      { timeout: 30_000 }
    )
    .toBe('Mixed Case Title');

  // ---- Escape restores; a pasted HTML payload lands as plain text ----
  await heading.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('discard me');
  await page.keyboard.press('Escape');
  await expect(heading).not.toHaveText(/discard me/i);
  await heading.click();
  await page.keyboard.press('ControlOrMeta+A');
  await heading.evaluate(el => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'plain part');
    dt.setData('text/html', '<b onclick="x()">bold</b><img src=x onerror="x()">');
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
    );
  });
  await expect(heading).toHaveText(/plain part/i);
  expect(await heading.evaluate(el => el.querySelector('b, img') === null)).toBe(true);
  await page.keyboard.press('Escape');

  // ---- change image opens the admin's picker (the canvas only names the target) ----
  const change = frame.locator('[data-builder-change-image]').first();
  await expect(change).toBeVisible();
  await change.click();
  await expect(page.getByTestId('media-picker')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('media-picker')).toHaveCount(0);

  // ---- drag with the real pointer: drop the section on top of the one above it ----
  await frame
    .locator(`[data-builder-id="${added}"] > *`)
    .first()
    .click({ position: { x: 4, y: 4 } });
  const handle = frame.locator('[data-builder-toolbar="drag"]');
  await expect(handle).toBeVisible();
  const h = (await handle.boundingBox())!;
  const target = await box(frame, prev);
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2, h.y - 30, { steps: 4 });
  await page.mouse.move(target.x + 40, target.y + 6, { steps: 12 });
  await expect(frame.locator('[data-builder-drop-line]')).toBeVisible();
  await page.mouse.up();
  await expect.poll(async () => (await templateIds(page)).indexOf(added)).toBe(at - 1);
  await expect
    .poll(async () => (await draft(page, id, token)).sections.map(s => s.id).indexOf(added), {
      timeout: 30_000,
    })
    .toBe(at - 1);
  // one undo puts it back
  await page.getByTestId('undo').click();
  await expect.poll(async () => (await templateIds(page)).indexOf(added)).toBe(at);

  // ---- toolbar remove: asks in the app, then leaves the store as it was ----
  await frame
    .locator(`[data-builder-id="${added}"] > *`)
    .first()
    .click({ position: { x: 4, y: 4 } });
  await frame.locator('[data-builder-toolbar="remove"]').click();
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  await page.getByTestId('confirm-ok').click();
  await expect.poll(async () => await templateIds(page)).toEqual(before);
  await expect
    .poll(async () => (await draft(page, id, token)).sections.some(s => s.id === added), {
      timeout: 30_000,
    })
    .toBe(false);
});
