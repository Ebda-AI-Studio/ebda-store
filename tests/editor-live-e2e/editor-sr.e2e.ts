/**
 * Screen-reader and keyboard pass on the REAL stack (real admin, real storefront canvas, real API
 * in workerd, real Postgres): the editor chrome's accessibility tree (names, roles, landmarks,
 * heading order, tab pattern), the Tab order and its skip links, the `builder-live` announcements
 * after select / move / hide / remove / undo, and the keyboard + IME flows on the real canvas.
 *
 * Browser accessibility-tree reads (`ariaSnapshot`), not a human screen reader: VoiceOver itself is
 * not driven here (see docs/plans/2026-10-23-launch-polish.md). `npm run test:editor-live`.
 */
import { test, expect, type Page, type BrowserContext, type Frame } from '@playwright/test';

const STORE_ORIGIN = 'https://dahab-preview.ebda.app';
const OWNER = {
  email: 'dahab-demo@ebda.app',
  password: process.env.EDITOR_E2E_OWNER_PW || 'Editor-e2e#2026',
};
let LANG: 'ar' | 'en' = 'ar';
const L = (ar: string, en: string) => (LANG === 'ar' ? ar : en);

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
      // the page closed while this fetch was in flight (end of a test): nothing to serve
    }
  });
}

// The API throttles logins (5 per 15 min per IP + email): sign in ONCE, then every test starts from
// the saved cookies + localStorage instead of the form.
let session: {
  cookies: Awaited<ReturnType<BrowserContext['cookies']>>;
  local: Record<string, string>;
} | null = null;

async function login(page: Page) {
  const base = test.info().project.use.baseURL!;
  await page.context().addCookies([{ name: 'admin-lang', value: LANG, url: base }]);
  if (session) {
    await page.context().addCookies(session.cookies.filter(c => c.name !== 'admin-lang'));
    const local = session.local;
    await page.addInitScript(entries => {
      for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
    }, local);
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

async function openBuilder(page: Page): Promise<{ frame: Frame; id: string; token: string }> {
  await routeStorefront(page.context());
  await login(page);
  const apiUrl = test.info().config.metadata.apiUrl as string;
  const token = (await page.evaluate(() => localStorage.getItem('accessToken'))) ?? '';
  const r = await page.request.get(`${apiUrl}/api/v1/admin/stores`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const body = await r.json();
  const stores = (body.data?.stores ?? body.data) as Array<{ id: string; slug: string }>;
  const id = stores.find(s => s.slug === 'dahab-preview')!.id;
  await page.goto(`/stores/${id}/builder`);
  await expect(page.getByTestId('builder')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[role="status"]', { hasText: /تحميل|Loading/ })).toHaveCount(0, {
    timeout: 90_000,
  });
  const frame = page.frames().find(f => f.url().startsWith(`${STORE_ORIGIN}/`))!;
  await expect(frame.locator('[data-builder-id]').first()).toBeAttached();
  return { frame, id, token };
}

/** The session is a cookie (the API sets it); a bearer header only when localStorage holds one. */
const auth = async (page: Page, fallback: string): Promise<Record<string, string>> => {
  const t = (await page.evaluate(() => localStorage.getItem('accessToken'))) || fallback;
  return t ? { Authorization: `Bearer ${t}` } : {};
};
/** Tests that add a section take it out again: the draft is saved server-side between tests. */
async function removeSection(page: Page, sid: string) {
  const row = page.getByTestId(`tree-row-${sid}`);
  if (!(await row.count())) return;
  await row.getByRole('button', { name: /^(خيارات|Options)/ }).click();
  await page.getByRole('menuitem', { name: L('حذف', 'Delete'), exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', {
    timeout: 30_000,
  });
}
/** Adds a fresh "image + text" section (any left over from an aborted run goes first: it is capped). */
async function addImageText(page: Page): Promise<string> {
  for (const stale of (await treeIds(page)).filter(x => x.startsWith('image-text')))
    await removeSection(page, stale);
  const before = await treeIds(page);
  await page.getByTestId('add-section-template').click();
  await page.getByTestId('preset-image-text-0').click();
  await expect.poll(async () => (await treeIds(page)).length).toBe(before.length + 1);
  return (await treeIds(page)).find(x => !before.includes(x))!;
}
const live = (page: Page) => page.getByTestId('builder-live');
const treeIds = (page: Page) =>
  page
    .getByTestId('tree-group-template')
    .locator('[data-testid^="tree-row-"]')
    .evaluateAll(els => els.map(e => e.getAttribute('data-testid')!.replace('tree-row-', '')));
/** A control in the browser's own accessibility tree with no name: `- button:` / `- textbox [..]:`. */
const NAMELESS =
  /^\s*- (button|textbox|combobox|checkbox|radio|switch|link|spinbutton|slider|tab)(?: \[[^\]]*\])*(?::|$)/gm;

for (const lang of ['ar', 'en'] as const) {
  test.describe(`screen reader + keyboard, ${lang} 1280`, () => {
    test.use({
      viewport: { width: 1280, height: 1000 },
      locale: lang === 'ar' ? 'ar-EG' : 'en-US',
    });
    test.beforeEach(() => {
      LANG = lang;
    });

    test('landmarks, one h1, h2 pane headings, tab pattern, every control named', async ({
      page,
    }) => {
      test.setTimeout(240_000);
      await openBuilder(page);
      // landmarks: one banner, one main (the canvas), the two panes as labelled complementary
      await expect(page.locator('h1')).toHaveCount(1);
      await expect(page.locator('h1')).toContainText(L('محرر المتجر', 'Store editor'));
      await expect(page.locator('header')).toHaveCount(1);
      await expect(page.locator('main')).toHaveCount(1);
      await expect(page.locator('aside[aria-label]')).toHaveCount(2);
      // no heading level is skipped inside the panes: the tree groups are h2, like the settings
      expect(await page.locator('aside h3').count()).toBe(0);
      expect(await page.locator('aside').first().locator('h2').count()).toBeGreaterThan(0);

      // the tabs are a real tab pattern: aria-controls resolves to a tabpanel, one Tab stop,
      // arrows move + activate (Left is "next" in Arabic, so the pair of keys is direction-aware)
      const tabs = page.locator('aside').first().getByRole('tab');
      expect(await tabs.count()).toBe(3);
      const panelId = await tabs.first().getAttribute('aria-controls');
      await expect(page.locator(`[role="tabpanel"]#${panelId}`)).toBeVisible();
      await expect(tabs.first()).toHaveAttribute('tabindex', '0');
      await expect(tabs.nth(1)).toHaveAttribute('tabindex', '-1');
      await tabs.first().focus();
      await page.keyboard.press(lang === 'ar' ? 'ArrowLeft' : 'ArrowRight');
      await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
      await expect(tabs.nth(1)).toBeFocused();
      await page.keyboard.press(lang === 'ar' ? 'ArrowRight' : 'ArrowLeft');
      await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
      // the preview-size radios: one Tab stop, arrows move the choice
      const radios = page.getByRole('radiogroup').getByRole('radio');
      await radios
        .filter({ has: page.locator(':scope') })
        .first()
        .focus();
      const checkedBefore = await radios.evaluateAll(rs =>
        rs.findIndex(r => r.getAttribute('aria-checked') === 'true')
      );
      await radios.nth(checkedBefore).focus();
      await page.keyboard.press('Home');
      await expect(radios.first()).toHaveAttribute('aria-checked', 'true');

      // every control in the chrome and in the settings of EVERY section has a name
      const nameless: string[] = [];
      const scan = async (what: string) => {
        for (const part of [
          page.locator('header'),
          page.locator('aside').first(),
          page.locator('aside').last(),
        ]) {
          const snap = await part.ariaSnapshot();
          for (const m of snap.matchAll(NAMELESS)) nameless.push(`${what}: ${m[0].trim()}`);
        }
      };
      await scan('page settings');
      const ids = await treeIds(page);
      for (const sid of ids) {
        await page.getByTestId(`tree-select-${sid}`).click();
        for (const mode of ['content', 'design'] as const) {
          const tab = page.locator(`#settings-mode-${mode}`);
          if (await tab.count()) await tab.click();
          await scan(`${sid}/${mode}`);
        }
      }
      expect(nameless).toEqual([]);
    });

    test('skip links: "skip to main content" lands on the preview and the tree is skipped', async ({
      page,
    }) => {
      await openBuilder(page);
      // a fresh page load: the sequential focus start point is the very top of the document
      await page.evaluate(() => {
        const start = document.createElement('i');
        start.tabIndex = -1;
        document.body.prepend(start);
        start.focus();
      });
      await page.keyboard.press('Tab');
      const skip = page.locator('a[href="#admin-main-content"]');
      await expect(skip).toBeFocused();
      await expect(skip).toBeVisible(); // revealed on focus
      await page.keyboard.press('Enter');
      // the link's target exists on this page (it used to be a dead link) and holds the preview
      await expect(page.locator('main#admin-main-content')).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.locator('#builder-canvas-region')).toBeFocused();
      // and "skip to settings" jumps over the whole tree to the settings pane
      await page.getByTestId('skip-to-settings').focus();
      await expect(page.getByTestId('skip-to-settings')).toBeVisible();
      await page.keyboard.press('Enter');
      await expect(page.locator('#builder-settings')).toBeFocused();
    });

    test('builder-live announces move, hide, remove and undo/redo', async ({ page }) => {
      test.setTimeout(240_000);
      await openBuilder(page);
      const row = (sid: string) => page.getByTestId(`tree-select-${sid}`);
      const ids = await treeIds(page);
      const mover = ids[2];
      await row(mover).click();
      await row(mover).focus();
      await page.keyboard.press('Alt+ArrowDown');
      await expect(live(page)).toHaveText(
        L(/اتنقل القسم .+ لتحت، بقى رقم 4 من/, /Moved .+ down, now 4 of/)
      );
      await expect(row(mover)).toBeFocused(); // the focus stays on the row that moved

      await page.getByTestId('undo').click();
      await expect(live(page)).toHaveText(L(/لفوق، بقى رقم 3 من/, /up, now 3 of/));

      // the last section that can be hidden: an earlier test may have left one hidden ("Show"), a
      // pinned one has no hide button at all
      let victim = ids[ids.length - 1];
      for (const sid of [...ids].reverse()) {
        if (
          await page
            .getByTestId(`tree-row-${sid}`)
            .getByRole('button', { name: L(/^إخفاء/, /^Hide/) })
            .count()
        ) {
          victim = sid;
          break;
        }
      }
      await page
        .getByTestId(`tree-row-${victim}`)
        .getByRole('button', { name: L(/^إخفاء/, /^Hide/) })
        .first()
        .click();
      await expect(live(page)).toHaveText(L(/اتخبّى القسم/, /^Hid /));
      await page.getByTestId('undo').click();
      await expect(live(page)).toHaveText(L(/اتظهر القسم/, /^Showed /));

      await page
        .getByTestId(`tree-row-${victim}`)
        .getByRole('button', { name: L(/^خيارات/, /^Options/) })
        .click();
      await page.getByRole('menuitem', { name: L('حذف', 'Delete'), exact: true }).click();
      await expect(live(page)).toHaveText(
        L(/اتحذف القسم .+ فاضل \d+ قسم/, /^Removed .+ sections left/)
      );
      expect(await treeIds(page)).toHaveLength(ids.length - 1);
      await page.getByTestId('undo').click();
      await expect(live(page)).toHaveText(L(/اتضاف القسم/, /^Added /));
      expect(await treeIds(page)).toEqual(ids);
      await page.getByTestId('redo').click();
      await expect(live(page)).toHaveText(L(/اتحذف القسم/, /^Removed /));
      await page.getByTestId('undo').click();
    });

    test('the canvas frame is a document of its own: h1, landmarks, named controls', async ({
      page,
    }) => {
      const { frame } = await openBuilder(page);
      const snap = await frame.locator('body').ariaSnapshot();
      expect(snap).toMatch(/- main:/);
      expect(snap).toMatch(/- heading ".+" \[level=1\]/);
      expect(snap).toMatch(/- banner:/);
      expect(snap).toMatch(/- contentinfo:/);
      // the editor's own overlay chips and toolbar must not be exposed as stray content
      await frame.locator('[data-builder-id] > *').first().click();
      const sel = await frame.locator('body').ariaSnapshot();
      for (const m of sel.matchAll(NAMELESS)) {
        // the storefront's own known gap (search field uses a placeholder) is not the editor's
        expect(m[0]).not.toMatch(/button/);
      }
    });
  });
}

test.describe('keyboard + IME on the real canvas (ar 1280)', () => {
  test.use({ viewport: { width: 1280, height: 2000 }, locale: 'ar-EG' });
  test.beforeEach(() => {
    LANG = 'ar';
  });
  // in-flight storefront fetches must not outlive the test and mask its own failure
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('select on the canvas, move with Alt+Arrow and the buttons, undo', async ({ page }) => {
    test.setTimeout(240_000);
    const { frame } = await openBuilder(page);
    const ids = await treeIds(page);
    const sid = ids[2];
    await frame.locator(`[data-builder-id="${sid}"] > *`).first().click();
    await expect(page.getByTestId(`tree-select-${sid}`)).toHaveAttribute('aria-current', 'true');
    // keyboard on the canvas: the selected section moves with Alt+ArrowDown
    await frame.locator('body').press('Alt+ArrowDown');
    await expect.poll(async () => (await treeIds(page)).indexOf(sid)).toBe(3);
    await expect(live(page)).toHaveText(/لتحت، بقى رقم 4 من/);
    // the canvas follows the tree: the same relative order in the storefront document (a section
    // an earlier test hid is in the tree but not in the canvas)
    const canvasOrder = await frame
      .locator('[data-builder-id]')
      .evaluateAll(els =>
        els
          .filter(e => !e.parentElement?.closest('[data-builder-id]'))
          .map(e => e.getAttribute('data-builder-id')!)
      );
    const treeNow = await treeIds(page);
    expect(canvasOrder.filter(x => treeNow.includes(x))).toEqual(
      treeNow.filter(x => canvasOrder.includes(x))
    );
    // the tree buttons
    await page
      .getByRole('button', { name: new RegExp(`^حرّك .+ لأعلى`) })
      .first()
      .waitFor();
    await page
      .getByTestId(`tree-row-${sid}`)
      .getByRole('button', { name: /لأعلى$/ })
      .first()
      .click();
    await expect.poll(async () => (await treeIds(page)).indexOf(sid)).toBe(2);
    await page.getByTestId('undo').click();
    await expect.poll(async () => (await treeIds(page)).indexOf(sid)).toBe(3);
    await page.getByTestId('undo').click();
    await expect.poll(async () => (await treeIds(page)).indexOf(sid)).toBe(2);
  });

  test('IME: Enter inside an open composition confirms the candidate, it does not commit', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const { frame, id, token } = await openBuilder(page);
    const apiUrl = test.info().config.metadata.apiUrl as string;
    const saved = async (key: string) => {
      const r = await page.request.get(`${apiUrl}/api/v1/admin/stores/${id}/builder/pages/home`, {
        headers: await auth(page, token),
      });
      const def = (await r.json()).data.definition as {
        sections: Array<{ id: string; settings: Record<string, string> }>;
      };
      return def.sections.find(s => s.id === sectionId)?.settings[key];
    };
    // a fresh image + text section: its heading is an inline target whatever look the store has
    const sectionId = await addImageText(page);
    const heading = frame
      .locator(`[data-builder-id="${sectionId}"] [data-builder-setting]`)
      .first();
    const key = (await heading.getAttribute('data-builder-setting'))!;
    await frame.locator(`[data-builder-id="${sectionId}"] > *`).first().click();
    await heading.click();
    await expect(heading).toHaveAttribute('contenteditable', /.+/);
    await page.keyboard.press('ControlOrMeta+A');
    // a real IME composition through CDP: the text is "composing" until it is committed
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'مرحب', selectionStart: 4, selectionEnd: 4 });
    // The composition's own Enter, both ways engines report it: key "Enter" + keyCode 229 (the
    // IME owns the key), and a plain keyCode 13 that arrives while the composition is open
    // (`isComposing`). Neither may commit the field. The control is the plain Enter below, which
    // does commit once the composition is closed, so the key handler is live in this test.
    for (const code of [229, 13]) {
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: code,
      });
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: code,
      });
      await page.waitForTimeout(300);
      await expect(heading).toHaveAttribute('contenteditable', /.+/);
    }
    await cdp.send('Input.insertText', { text: 'مرحبا بكم IME' });
    await expect(heading).toHaveAttribute('contenteditable', /.+/); // still editing
    await page.keyboard.press('Enter'); // the real Enter, no composition: commits
    await expect(heading).not.toHaveAttribute('contenteditable', /.+/);
    await expect.poll(() => saved(key), { timeout: 30_000 }).toBe('مرحبا بكم IME');
    await removeSection(page, sectionId);
  });

  test('look switch: preview in the canvas, then apply', async ({ page }) => {
    test.setTimeout(240_000);
    const { id, token } = await openBuilder(page);
    const apiUrl = test.info().config.metadata.apiUrl as string;
    const lookOf = async () => {
      const r = await page.request.get(`${apiUrl}/api/v1/admin/stores`, {
        headers: await auth(page, token),
      });
      const b = await r.json();
      const list = (b.data?.stores ?? b.data) as Array<{ id: string; look?: string | null }>;
      return list.find(x => x.id === id)?.look ?? null;
    };
    const before = await lookOf();
    await page.getByTestId('open-look-switch').click();
    await expect(page.getByTestId('look-switch-pane')).toBeVisible();
    const radios = page.getByTestId('look-switch-pane').getByRole('radio', { name: /./ });
    // pick the first look radio that is not the current one (the picker tabs by template)
    const dahabTab = page.getByTestId('look-switch-pane').getByRole('tab', { name: 'دهب' });
    if (await dahabTab.count()) await dahabTab.click();
    const n = await radios.count();
    let picked = -1;
    for (let i = 0; i < n; i++) {
      if (!(await radios.nth(i).isChecked())) {
        picked = i;
        break;
      }
    }
    expect(picked).toBeGreaterThanOrEqual(0);
    await radios.nth(picked).click();
    await page.getByTestId('look-preview').click();
    await expect(page.getByTestId('look-preview-bar')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('look-apply')).toBeVisible();
    // nothing is saved by a preview
    expect(await lookOf()).toBe(before);
    await page.getByTestId('look-apply').click();
    await page.getByTestId('confirm-ok').click();
    await expect.poll(lookOf, { timeout: 60_000 }).not.toBe(before);
  });

  test('image swap: the picker thumbnails are named, pick + describe is one undo step', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    // The local API has no S3 behind it (`/uploads/list` is a 503 here), so the LIST is served by
    // the test; the picker, the swap dialog, the draft write and Undo are all real.
    const photo = 'https://media.ebda.app/stores/e2e/builder/swap-test.jpg';
    await page.route('**/api/v1/uploads/list**', route =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            items: [
              { key: 'stores/e2e/builder/swap-test.jpg', url: photo, size: 1, lastModified: null },
            ],
            nextCursor: null,
          },
        }),
      })
    );
    const { frame, id, token } = await openBuilder(page);
    const sid = await addImageText(page);
    const apiUrl = test.info().config.metadata.apiUrl as string;
    const imageOf = async () => {
      const r = await page.request.get(`${apiUrl}/api/v1/admin/stores/${id}/builder/pages/home`, {
        headers: await auth(page, token),
      });
      const def = (await r.json()).data.definition as {
        sections: Array<{ id: string; settings: Record<string, string> }>;
      };
      return def.sections.find(x => x.id === sid)?.settings.image;
    };
    await frame.locator(`[data-builder-id="${sid}"] > *`).first().click();
    await frame.locator('[data-builder-change-image]').first().click();
    const thumb = page
      .getByTestId('media-picker')
      .getByRole('button', { name: /اختار الصورة 1: swap-test\.jpg/ });
    await expect(thumb).toBeVisible();
    await thumb.click();
    if (await page.getByTestId('image-swap-alt').count()) {
      await page.getByTestId('swap-alt-en').fill('Swap test');
      await page.getByTestId('swap-apply').click();
    }
    await expect.poll(imageOf, { timeout: 30_000 }).toBe(photo);
    await page.getByTestId('undo').click();
    await expect.poll(imageOf, { timeout: 30_000 }).not.toBe(photo);
    await removeSection(page, sid);
  });
});

test.describe('phone 390, ar: drawers, inline edit, publish', () => {
  test.use({ viewport: { width: 390, height: 844 }, locale: 'ar-EG' });
  test.beforeEach(() => {
    LANG = 'ar';
  });
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('the drawers announce their state, a canvas edit saves and Publish reaches the storefront', async ({
    page,
    context,
  }) => {
    test.setTimeout(300_000);
    const { frame, id, token } = await openBuilder(page);
    const apiUrl = test.info().config.metadata.apiUrl as string;
    const drawer = page.getByRole('button', { name: 'الهيكل', exact: true });
    await expect(drawer).toHaveAttribute('aria-expanded', 'false');
    await drawer.click();
    await expect(drawer).toHaveAttribute('aria-expanded', 'true');
    const sid = await addImageText(page);
    await expect(live(page)).toHaveText(/اتضاف القسم صورة مع نص/); // announced with the drawer open
    await page.keyboard.press('Escape'); // Esc closes the drawer and gives focus back to its opener
    await expect(drawer).toHaveAttribute('aria-expanded', 'false');
    await expect(drawer).toBeFocused();

    const text = `تعديل من الموبايل ${Date.now() % 100000}`;
    const heading = frame.locator(`[data-builder-id="${sid}"] [data-builder-setting]`).first();
    const key = (await heading.getAttribute('data-builder-setting'))!;
    await heading.scrollIntoViewIfNeeded();
    await heading.click(); // first tap selects the section
    await page.waitForTimeout(400);
    await heading.click(); // second tap edits
    await expect(heading).toHaveAttribute('contenteditable', /.+/);
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.insertText(text);
    await page.keyboard.press('Enter');
    const read = async () => {
      const r = await page.request.get(`${apiUrl}/api/v1/admin/stores/${id}/builder/pages/home`, {
        headers: await auth(page, token),
      });
      return (await r.json()).data as {
        draftRev: number;
        publishedRev: number;
        definition: { sections: Array<{ id: string; settings: Record<string, string> }> };
      };
    };
    await expect
      .poll(async () => (await read()).definition.sections.find(x => x.id === sid)?.settings[key], {
        timeout: 30_000,
      })
      .toBe(text);

    // a fresh section still holds placeholder text: Publish refuses, and says so as an alert
    await page.getByTestId('publish').click();
    await expect(page.getByRole('alert').filter({ hasText: /لسه ماتنشرش/ })).toBeVisible();
    // the settings drawer: the body text, both languages, replaces the placeholder
    const settings = page.getByRole('button', { name: 'الإعدادات', exact: true });
    await settings.click();
    await expect(settings).toHaveAttribute('aria-expanded', 'true');
    await page.getByTestId('field-body').fill('A real description written on a phone.');
    await page.getByTestId('field-bodyAr').fill('وصف حقيقي اتكتب من الموبايل.');
    await page.keyboard.press('Escape');
    await expect(settings).toHaveAttribute('aria-expanded', 'false');
    await expect(settings).toBeFocused();
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', {
      timeout: 30_000,
    });
    await page.getByTestId('publish').click();
    // the published revision catches up with the draft: Publish really went through
    await expect
      .poll(async () => (await read()).publishedRev >= (await read()).draftRev, { timeout: 30_000 })
      .toBe(true);
    await expect(page.getByTestId('publish-blockers')).toHaveCount(0);
    const shop = await context.newPage();
    await expect
      .poll(
        async () => {
          await shop.goto(`${STORE_ORIGIN}/`, { waitUntil: 'domcontentloaded' });
          return shop.locator('main').innerText();
        },
        { timeout: 120_000, intervals: [2_000, 5_000, 10_000] }
      )
      .toContain(text);
    await expect(shop.locator('[data-builder-id]')).toHaveCount(0);
    await shop.close();
    // leave the store as found: the section comes out again and the clean page is published
    await drawer.click();
    await removeSection(page, sid);
    await page.keyboard.press('Escape');
    await page.getByTestId('publish').click();
    await expect
      .poll(async () => (await read()).publishedRev >= (await read()).draftRev, { timeout: 30_000 })
      .toBe(true);
  });
});
