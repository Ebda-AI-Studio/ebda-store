/**
 * Visual builder (Phase 2) end to end, in ar (RTL) and en at 390 / 820 /
 * 1280: add a section from the picker, reorder by keyboard and by buttons,
 * duplicate / hide / delete, edit text in the generated settings panel, an
 * inline edit coming back from the canvas, undo/redo, the viewport switch,
 * draft autosave, publish, the conflict choice, and the canvas origin gate.
 */
import { test, expect, type Page, type FrameLocator } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const API = `http://localhost:${process.env.MOCK_API_PORT || 4510}/api/v1`;
const STORE_ID = '0a0b0c0d-0000-4000-8000-00000000e2e0';
const CANVAS_ORIGIN = 'https://e2e-store.ebda.app';
const FAKE_CANVAS = readFileSync(join(__dirname, 'fake-canvas.html'), 'utf8');

type State = {
  rev: number;
  draft: {
    definition: {
      sections: Array<{
        id: string;
        type: string;
        hidden?: boolean;
        settings: Record<string, unknown>;
      }>;
    };
  } | null;
  published: unknown;
  saves: number;
  publishes: number;
};

async function state(page: Page): Promise<State> {
  const r = await page.request.get(`${API}/__test/state`);
  return (await r.json()).data;
}

function locale(): 'ar' | 'en' {
  return test.info().project.name.startsWith('ar') ? 'ar' : 'en';
}
const narrow = (page: Page) => (page.viewportSize()?.width ?? 1280) < 1024;
const L = (ar: string, en: string) => (locale() === 'ar' ? ar : en);

async function openBuilder(page: Page) {
  await page.request.post(`${API}/__test/reset`);
  await page
    .context()
    .addCookies([{ name: 'admin-lang', value: locale(), url: 'http://localhost:3101' }]);
  await page.addInitScript(() => localStorage.setItem('accessToken', 'e2e'));
  await page.route(`${CANVAS_ORIGIN}/**`, r =>
    r.fulfill({ contentType: 'text/html', body: FAKE_CANVAS })
  );
  await page.goto(`/stores/${STORE_ID}/builder`);
  await expect(page.getByTestId('builder')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('html')).toHaveAttribute('dir', locale() === 'ar' ? 'rtl' : 'ltr');
}

async function structure(page: Page) {
  if (narrow(page) && !(await page.getByTestId('tree-group-template').isVisible()))
    await page
      .getByRole('button', { name: L('الهيكل', 'Structure') })
      .first()
      .click();
  await expect(page.getByTestId('tree-group-template')).toBeVisible();
}
async function settings(page: Page) {
  if (narrow(page) && !(await page.getByTestId('settings-panel').isVisible()))
    await page
      .getByRole('button', { name: L('الإعدادات', 'Settings') })
      .first()
      .click();
  await expect(page.getByTestId('settings-panel')).toBeVisible();
}
const canvas = (page: Page): FrameLocator => page.frameLocator('[data-testid="builder-canvas"]');
async function templateIds(page: Page): Promise<string[]> {
  return page
    .getByTestId('tree-group-template')
    .locator('[data-testid^="tree-row-"]')
    .evaluateAll(els => els.map(e => e.getAttribute('data-testid')!.replace('tree-row-', '')));
}
async function waitSaved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', {
    timeout: 15_000,
  });
}

test('add, reorder (keyboard + buttons), duplicate, hide, delete, autosave', async ({ page }) => {
  await openBuilder(page);
  await structure(page);
  const before = await templateIds(page);
  expect(before.slice(0, 2)).toEqual(['hero', 'categories']);

  // add image-text from the picker (preset with preview)
  await page.getByTestId('add-section-template').click();
  await expect(page.getByTestId('add-section-dialog')).toBeVisible();
  await page.getByTestId('preset-image-text-0').click();
  await structure(page);
  await expect(page.getByTestId('tree-row-image-text-1')).toBeVisible();

  // keyboard reorder: Alt+ArrowUp moves it up one
  const ids1 = await templateIds(page);
  const at = ids1.indexOf('image-text-1');
  await page.getByTestId('tree-select-image-text-1').press('Alt+ArrowUp');
  expect((await templateIds(page)).indexOf('image-text-1')).toBe(at - 1);
  // button reorder
  await page
    .getByRole('button', {
      name: L('حرّك صورة مع نص لأعلى', 'Move Image with text up'),
      exact: true,
    })
    .click();
  expect((await templateIds(page)).indexOf('image-text-1')).toBe(at - 2);

  // duplicate, hide, delete
  await page
    .getByRole('button', { name: L('تكرار صورة مع نص', 'Duplicate Image with text'), exact: true })
    .first()
    .click();
  await structure(page);
  await expect(page.getByTestId('tree-row-image-text-2')).toBeVisible();
  await page
    .getByTestId('tree-row-image-text-2')
    .getByRole('button', { name: L('إخفاء صورة مع نص', 'Hide Image with text'), exact: true })
    .click();
  await page
    .getByTestId('tree-row-image-text-1')
    .getByRole('button', { name: L('حذف صورة مع نص', 'Remove Image with text'), exact: true })
    .click();
  await expect(page.getByTestId('tree-row-image-text-1')).toHaveCount(0);

  // autosave reaches the API as a validated draft
  await waitSaved(page);
  const s = await state(page);
  const it2 = s.draft!.definition.sections.find(x => x.id === 'image-text-2');
  expect(it2?.hidden).toBe(true);
  expect(s.draft!.definition.sections.some(x => x.id === 'image-text-1')).toBe(false);
});

test('settings panel edits text (ar + en side by side); canvas re-renders; inline edit; undo/redo', async ({
  page,
}) => {
  await openBuilder(page);
  await structure(page);
  await page.getByTestId('tree-select-categories').click();
  await settings(page);
  const ar = page.getByTestId('field-titleAr');
  await expect(ar).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId('field-title')).toHaveAttribute('dir', 'ltr');
  await ar.fill('فئاتنا');
  // the canvas received a render carrying the edit (no reload)
  await expect
    .poll(async () =>
      canvas(page)
        .locator('body')
        .evaluate(
          () =>
            (window as any).__doc?.sections.find((s: any) => s.id === 'categories')?.settings
              .titleAr
        )
    )
    .toBe('فئاتنا');
  await waitSaved(page);
  expect(
    (await state(page)).draft!.definition.sections.find(x => x.id === 'categories')!.settings
      .titleAr
  ).toBe('فئاتنا');

  // inline edit from the canvas comes back as a setting change
  await canvas(page)
    .locator('body')
    .evaluate(() => (window as any).__patch('categories', 'title', 'Our range'));
  await expect(page.getByTestId('field-title')).toHaveValue('Our range');

  // undo / redo (focus off inputs so native text undo is not used)
  await page.getByTestId('undo').click();
  await expect(page.getByTestId('field-title')).toHaveValue('Shop by category');
  await page.getByTestId('redo').click();
  await expect(page.getByTestId('field-title')).toHaveValue('Our range');
});

test('click in the canvas selects the section in the tree and panel', async ({ page }) => {
  await openBuilder(page);
  await canvas(page).locator('[data-builder-id="categories"]').click();
  await settings(page);
  await expect(page.getByTestId('settings-panel').getByRole('heading')).toHaveText(
    L('الفئات', 'Categories')
  );
});

test('click on a hero slide selects the slide; header and footer select their sections', async ({
  page,
}) => {
  await openBuilder(page);
  // dispatchEvent: at 390 a pane drawer can sit over the canvas, which Playwright cannot see from the frame
  await canvas(page).locator('[data-builder-block="slide-2"]').dispatchEvent('click');
  await settings(page);
  // the slide's own settings are open (its headline field carries slide 2's value)
  await expect(page.getByTestId('field-headline')).toHaveValue('Gift boxes');
  await structure(page);
  await expect(page.getByTestId('tree-block-hero-slide-2').getByRole('button').first()).toHaveClass(
    /ring-primary/
  );

  await canvas(page).locator('[data-zone="header"]').dispatchEvent('click');
  await settings(page);
  await expect(page.getByTestId('header-chrome-content')).toBeVisible();
  await canvas(page).locator('[data-zone="footer"]').dispatchEvent('click');
  await settings(page);
  await expect(page.getByTestId('footer-chrome-content')).toBeVisible();
});

test('inline Arabic edit of a slide headline reaches the draft, undo restores it; a non-text key is dropped', async ({
  page,
}) => {
  await openBuilder(page);
  const slideHeadline = async () => {
    const hero = (await state(page)).draft?.definition.sections.find(x => x.id === 'hero') as
      | { blocks?: Array<{ id: string; settings: Record<string, unknown> }> }
      | undefined;
    return hero?.blocks?.find(b => b.id === 'slide-2')?.settings.headlineAr;
  };
  await canvas(page)
    .locator('body')
    .evaluate(() => (window as any).__patch('hero', 'headlineAr', 'علب جديدة', 'slide-2'));
  await waitSaved(page);
  expect(await slideHeadline()).toBe('علب جديدة');

  // a key that is not a text setting of the block never reaches the document
  const saves = (await state(page)).saves;
  await canvas(page)
    .locator('body')
    .evaluate(() => (window as any).__patch('hero', 'image', 'https://evil.test/x.png', 'slide-2'));
  await page.waitForTimeout(1600);
  expect((await state(page)).saves).toBe(saves);

  await page.getByTestId('undo').click();
  await waitSaved(page);
  expect(await slideHeadline()).toBe('علب هدايا');
});

test('change image from the canvas: pick, describe, one undo step; a non-image key opens nothing', async ({
  page,
}) => {
  await openBuilder(page);
  const slide = async () => {
    const hero = (await state(page)).draft?.definition.sections.find(x => x.id === 'hero') as
      | { blocks?: Array<{ id: string; settings: Record<string, unknown> }> }
      | undefined;
    return hero?.blocks?.find(b => b.id === 'slide-2')?.settings;
  };
  // the canvas names a target that is NOT an image setting: nothing opens
  await canvas(page)
    .locator('body')
    .evaluate(() => (window as any).__requestMedia('hero', 'headline', 'slide-2'));
  await page.waitForTimeout(500);
  await expect(page.getByTestId('media-picker')).toHaveCount(0);

  await canvas(page)
    .locator('body')
    .evaluate(() => (window as any).__requestMedia('hero', 'image', 'slide-2'));
  await expect(page.getByTestId('media-picker')).toBeVisible();
  // the recommended size comes from the image standard, in the admin language
  await expect(page.getByTestId('media-hint')).toContainText(L('الحجم الموصى به', 'Recommended'));
  await page.getByTestId('media-picker').locator('ul button').first().click();

  // a slide has an alt text: the description step follows the pick
  await expect(page.getByTestId('image-swap-alt')).toBeVisible();
  await page.getByTestId('swap-alt-en').fill('Gift boxes of dates');
  await page.getByTestId('swap-apply').click();
  await expect(page.getByTestId('image-swap-alt')).toHaveCount(0);
  await waitSaved(page);
  expect(await slide()).toMatchObject({
    image: 'https://media.ebda.app/stores/e2e/builder/a.jpg',
    alt: 'Gift boxes of dates',
  });

  // the picture and its description are ONE undo step
  await page.getByTestId('undo').click();
  await waitSaved(page);
  expect(await slide()).toMatchObject({ image: 'https://media.ebda.app/hero-2.jpg' });
  expect((await slide())?.alt).toBeUndefined();
});

test('viewport switch sizes the canvas 1280 / 820 / 390', async ({ page }) => {
  await openBuilder(page);
  for (const [v, w] of [
    ['desktop', 1280],
    ['tablet', 820],
    ['mobile', 390],
  ] as const) {
    await page.getByTestId(`viewport-${v}`).click();
    await expect(page.getByTestId('builder-canvas')).toHaveAttribute('data-viewport', v);
    await expect(page.getByTestId('builder-canvas')).toHaveCSS('width', `${w}px`);
  }
});

test('publish flushes the draft and publishes it', async ({ page }) => {
  await openBuilder(page);
  await structure(page);
  await page
    .getByTestId('tree-row-hero')
    .getByRole('button', { name: L('إخفاء البانر الرئيسي', 'Hide Hero banner'), exact: true })
    .click();
  await page.getByTestId('publish').click();
  await expect.poll(async () => (await state(page)).publishes).toBe(1);
  const s = await state(page);
  expect(s.draft).toBeNull();
});

test('publish keeps the latest edit made while an earlier autosave is pending', async ({
  page,
}) => {
  await openBuilder(page);
  await structure(page);
  await page.getByTestId('tree-select-categories').click();
  await settings(page);
  const title = page.getByTestId('field-title');
  let releaseFirst!: () => void;
  const held = new Promise<void>(resolve => {
    releaseFirst = resolve;
  });
  let firstStarted!: () => void;
  const started = new Promise<void>(resolve => {
    firstStarted = resolve;
  });
  let requests = 0;
  await page.route(`${API}/admin/stores/${STORE_ID}/builder/pages/home/draft`, async route => {
    if (route.request().method() === 'PUT' && ++requests === 1) {
      firstStarted();
      await held;
    }
    await route.continue();
  });
  try {
    await title.fill('First catalogue');
    await started;
    await title.fill('Second catalogue');
    await page.getByTestId('publish').click();
    await title.fill('Latest catalogue');
    // Let the latest edit debounce while the first HTTP response stays held.
    await page.waitForTimeout(1400);
    releaseFirst();
    await expect.poll(async () => (await state(page)).publishes).toBe(1);
    const published = (await state(page)).published as State['draft'];
    expect(published?.definition.sections.find(x => x.id === 'categories')?.settings.title).toBe(
      'Latest catalogue'
    );
    await expect(title).toHaveValue('Latest catalogue');
  } finally {
    releaseFirst();
  }
});

test('autosave waits for an in-flight publish and keeps later edits as a draft', async ({
  page,
}) => {
  await openBuilder(page);
  await structure(page);
  await page.getByTestId('tree-select-categories').click();
  await settings(page);
  const title = page.getByTestId('field-title');
  await title.fill('Published catalogue');
  await waitSaved(page);
  let releasePublish!: () => void;
  const held = new Promise<void>(resolve => {
    releasePublish = resolve;
  });
  let publishStarted!: () => void;
  const started = new Promise<void>(resolve => {
    publishStarted = resolve;
  });
  await page.route(`${API}/admin/stores/${STORE_ID}/builder/pages/home/publish`, async route => {
    publishStarted();
    await held;
    await route.continue();
  });
  try {
    await page.getByTestId('publish').click();
    await started;
    await title.fill('Next draft catalogue');
    await page.waitForTimeout(1400);
    releasePublish();
    await expect.poll(async () => (await state(page)).publishes).toBe(1);
    await waitSaved(page);
    const s = await state(page);
    const published = s.published as State['draft'];
    expect(published?.definition.sections.find(x => x.id === 'categories')?.settings.title).toBe(
      'Published catalogue'
    );
    expect(s.draft?.definition.sections.find(x => x.id === 'categories')?.settings.title).toBe(
      'Next draft catalogue'
    );
  } finally {
    releasePublish();
  }
});

test('a concurrent edit shows the conflict choice; "keep mine" saves over it explicitly', async ({
  page,
}) => {
  await openBuilder(page);
  await page.request.post(`${API}/__test/bump`); // another editor saved
  await structure(page);
  await page
    .getByTestId('tree-row-hero')
    .getByRole('button', { name: L('إخفاء البانر الرئيسي', 'Hide Hero banner'), exact: true })
    .click();
  await expect(page.getByTestId('conflict-banner')).toBeVisible({ timeout: 15_000 });
  const savesBefore = (await state(page)).saves;
  await page.getByRole('button', { name: L('احتفظ بنسختي', 'Keep mine') }).click();
  await waitSaved(page);
  const s = await state(page);
  expect(s.saves).toBe(savesBefore + 1);
  expect(s.draft!.definition.sections.find(x => x.id === 'hero')!.hidden).toBe(true);
});

test('a message from a foreign origin is ignored by the editor', async ({ page }) => {
  await openBuilder(page);
  await page.route('https://evil.example/**', r =>
    r.fulfill({
      contentType: 'text/html',
      body: `<script>parent.postMessage({protocol:'ebda-builder:v1',type:'patch-text',sectionId:'categories',key:'title',value:'PWNED'},'*')</script>`,
    })
  );
  await structure(page);
  await page.getByTestId('tree-select-categories').click();
  await settings(page);
  await page.evaluate(() => {
    // positive control: prove the hostile message really arrives at this window
    (window as any).__hostile = 0;
    window.addEventListener('message', e => {
      if (e.data?.value === 'PWNED') (window as any).__hostile += 1;
    });
    const f = document.createElement('iframe');
    f.src = 'https://evil.example/x';
    document.body.appendChild(f);
  });
  await expect.poll(() => page.evaluate(() => (window as any).__hostile)).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  await expect(page.getByTestId('field-title')).toHaveValue('Shop by category');
});

test('no horizontal document overflow on any editor panel (EDITOR-MOBILE-1)', async ({ page }) => {
  await openBuilder(page);
  const noOverflow = async (what: string) => {
    const m = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      cw: document.documentElement.clientWidth,
    }));
    expect(m.sw, `${what}: scrollWidth ${m.sw} > clientWidth ${m.cw}`).toBeLessThanOrEqual(m.cw);
  };
  await noOverflow('top bar + canvas');
  await expect(page.getByTestId('publish')).toBeInViewport();
  await expect(page.getByTestId('builder-canvas')).toBeVisible();

  await structure(page);
  await noOverflow('sections tree');
  const startTabs = page.getByRole('tablist').first().getByRole('tab');
  await startTabs.nth(1).click();
  await expect(page.getByTestId('theme-settings')).toBeVisible();
  await noOverflow('theme panel');
  await startTabs.nth(2).click();
  await expect(page.getByTestId('revisions-panel')).toBeVisible();
  await noOverflow('history panel');
  await startTabs.nth(0).click();

  await page
    .getByTestId('tree-group-template')
    .locator('[data-testid^="tree-select-"]')
    .first()
    .click();
  await settings(page);
  await noOverflow('settings panel (content)');
  await page.getByTestId('settings-panel').getByRole('tab').nth(1).click();
  await noOverflow('settings panel (design)');
});
