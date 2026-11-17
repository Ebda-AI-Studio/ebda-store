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
import arMessages from '../../apps/admin/src/i18n/messages/ar.json';
import enMessages from '../../apps/admin/src/i18n/messages/en.json';

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

async function state(page: Page, pageKey = 'home'): Promise<State> {
  const r = await page.request.get(`${API}/__test/state?page=${pageKey}`);
  return (await r.json()).data;
}

function locale(): 'ar' | 'en' {
  return test.info().project.name.startsWith('ar') ? 'ar' : 'en';
}
const narrow = (page: Page) => (page.viewportSize()?.width ?? 1280) < 1024;
const L = (ar: string, en: string) => (locale() === 'ar' ? ar : en);

/** A row's overflow menu action (Duplicate / Move up / Move down / Delete live there, not on the row). */
async function rowMenu(page: Page, sectionId: string, item: string) {
  await page
    .getByTestId(`tree-row-${sectionId}`)
    .getByRole('button', { name: /^(خيارات|Options)/ })
    .click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

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
  await rowMenu(page, 'image-text-1', L('تحريك لأعلى', 'Move up'));
  expect((await templateIds(page)).indexOf('image-text-1')).toBe(at - 2);

  // duplicate, hide, delete
  await rowMenu(page, 'image-text-1', L('تكرار', 'Duplicate'));
  await structure(page);
  await expect(page.getByTestId('tree-row-image-text-2')).toBeVisible();
  await page
    .getByTestId('tree-row-image-text-2')
    .getByRole('button', { name: L('إخفاء صورة مع نص', 'Hide Image with text'), exact: true })
    .click();
  await rowMenu(page, 'image-text-1', L('حذف', 'Delete'));
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
  // poll the draft: `saved` is also the idle state before the debounced autosave fires
  await expect.poll(slideHeadline, { timeout: 15_000 }).toBe('علب جديدة');

  // a key that is not a text setting of the block never reaches the document
  const saves = (await state(page)).saves;
  await canvas(page)
    .locator('body')
    .evaluate(() => (window as any).__patch('hero', 'image', 'https://evil.test/x.png', 'slide-2'));
  await page.waitForTimeout(1600);
  expect((await state(page)).saves).toBe(saves);

  await page.getByTestId('undo').click();
  await expect.poll(slideHeadline, { timeout: 15_000 }).toBe('علب هدايا');
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
  await expect.poll(slide, { timeout: 15_000 }).toMatchObject({
    image: 'https://media.ebda.app/stores/e2e/builder/a.jpg',
    alt: 'Gift boxes of dates',
  });

  // the picture and its description are ONE undo step
  await page.getByTestId('undo').click();
  await expect
    .poll(slide, { timeout: 15_000 })
    .toMatchObject({ image: 'https://media.ebda.app/hero-2.jpg' });
  expect((await slide())?.alt).toBeUndefined();
});

const sendFromCanvas = (page: Page, msg: Record<string, unknown>) =>
  canvas(page)
    .locator('body')
    .evaluate((_b, m) => (window as any).__send(m), msg);

test('canvas drop reorders the sections, the tree follows, one undo restores it', async ({
  page,
}) => {
  await openBuilder(page);
  await structure(page);
  const before = await templateIds(page);
  expect(before.length).toBeGreaterThan(2);
  const last = before[before.length - 1];
  // the canvas dropped the last section above the first
  await sendFromCanvas(page, { type: 'move', sectionId: last, toIndex: 0 });
  await expect.poll(async () => (await templateIds(page))[0]).toBe(last);
  expect(await templateIds(page)).toEqual([last, ...before.slice(0, -1)]);
  await expect
    .poll(async () => (await state(page)).draft?.definition.sections.map(x => x.id), {
      timeout: 15_000,
    })
    .toEqual([last, ...before.slice(0, -1)]);
  // ONE undo restores the original order
  await page.getByTestId('undo').click();
  expect(await templateIds(page)).toEqual(before);
  // a drop where it already is changes nothing and adds no history
  await sendFromCanvas(page, { type: 'move', sectionId: before[1], toIndex: 1 });
  await page.waitForTimeout(300);
  expect(await templateIds(page)).toEqual(before);
});

test('"+" between sections opens the picker and inserts at that index', async ({ page }) => {
  await openBuilder(page);
  await structure(page);
  const before = await templateIds(page);
  await sendFromCanvas(page, { type: 'request-add', list: 'template', index: 1 });
  await expect(page.getByTestId('add-section-dialog')).toBeVisible();
  await page.getByTestId('preset-image-text-0').click();
  await structure(page);
  const after = await templateIds(page);
  expect(after).toHaveLength(before.length + 1);
  expect(after[1]).toMatch(/^image-text/);
  expect(after.filter((_, i) => i !== 1)).toEqual(before);
  // an index past the end of the list is ignored
  await sendFromCanvas(page, { type: 'request-add', list: 'template', index: 40 });
  await page.waitForTimeout(300);
  await expect(page.getByTestId('add-section-dialog')).toHaveCount(0);
});

test('toolbar remove asks in the app first; cancel keeps it, confirm removes, undo restores', async ({
  page,
}) => {
  await openBuilder(page);
  await structure(page);
  const before = await templateIds(page);
  const target = before[1];
  let nativeDialogs = 0;
  page.on('dialog', d => {
    nativeDialogs++;
    void d.dismiss();
  });
  await sendFromCanvas(page, { type: 'section-op', sectionId: target, op: 'remove' });
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  await page.getByTestId('confirm-cancel').click();
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  expect(await templateIds(page)).toEqual(before);

  await sendFromCanvas(page, { type: 'section-op', sectionId: target, op: 'remove' });
  await page.getByTestId('confirm-ok').click();
  await structure(page);
  expect(await templateIds(page)).toEqual(before.filter(id => id !== target));
  await page.getByTestId('undo').click();
  expect(await templateIds(page)).toEqual(before);
  // never window.confirm
  expect(nativeDialogs).toBe(0);

  // moveDown / hide / duplicate act without a prompt, one reducer action each
  await sendFromCanvas(page, { type: 'section-op', sectionId: before[0], op: 'moveDown' });
  await expect.poll(async () => (await templateIds(page))[1]).toBe(before[0]);
  await sendFromCanvas(page, { type: 'section-op', sectionId: before[0], op: 'hide' });
  await waitSaved(page);
  expect((await state(page)).draft!.definition.sections.find(x => x.id === before[0])?.hidden).toBe(
    true
  );
});

test('section design: typography and dividers are editors in the panel, never a link to the classic page', async ({
  page,
}) => {
  await openBuilder(page);
  await structure(page);
  await page.getByTestId('tree-select-categories').click();
  await settings(page);
  await page.getByRole('tab', { name: L('التصميم', 'Design') }).click();
  // typography and dividers sit in the collapsed "Advanced" group of the design tab (#397): open it
  await page.getByTestId('advanced-design').getByRole('button').first().click();
  await expect(page.getByTestId('section-typography-field')).toBeVisible();
  await expect(page.getByTestId('dividers-field')).toBeVisible();
  await expect(page.locator('a[href*="page-builder"]')).toHaveCount(0);

  // a divider slot written through the panel reaches the draft as the section's `dividers`
  await page.getByTestId('dividers-field').locator('label').first().getByRole('switch').click();
  await expect
    .poll(
      async () =>
        (
          (await state(page)).draft?.definition.sections.find(x => x.id === 'categories')
            ?.settings as { dividers?: { above?: { enabled?: boolean } } } | undefined
        )?.dividers?.above?.enabled,
      { timeout: 15_000 }
    )
    .toBe(true);
});

test('AI fill from the canvas toolbar fills only the empty kicker and subtitle, as one undo step', async ({
  page,
}) => {
  await openBuilder(page);
  const settingsOf = async () =>
    (await state(page)).draft?.definition.sections.find(x => x.id === 'categories')?.settings as
      | Record<string, string>
      | undefined;
  // the merchant already wrote a kicker: it must survive
  await sendFromCanvas(page, {
    type: 'patch-text',
    sectionId: 'categories',
    key: 'kicker',
    value: 'MINE',
  });
  await expect.poll(async () => (await settingsOf())?.kicker, { timeout: 15_000 }).toBe('MINE');

  await sendFromCanvas(page, { type: 'section-op', sectionId: 'categories', op: 'aiFill' });
  await expect
    .poll(async () => (await settingsOf())?.subtitleAr, { timeout: 15_000 })
    .toBe('أفضل الاختيارات');
  const filled = await settingsOf();
  expect(filled).toMatchObject({ kicker: 'MINE', kickerAr: 'استكشف', subtitle: 'Top picks' });

  // one undo takes the whole fill back, the merchant's kicker stays
  await page.getByTestId('undo').click();
  await expect.poll(async () => (await settingsOf())?.subtitleAr, { timeout: 15_000 }).toBeFalsy();
  expect((await settingsOf())?.kicker).toBe('MINE');
  expect((await settingsOf())?.kickerAr).toBeFalsy();

  // an unsupported section (the hero) asks nothing and changes nothing
  const saves = (await state(page)).saves;
  await sendFromCanvas(page, { type: 'section-op', sectionId: 'hero', op: 'aiFill' });
  await page.waitForTimeout(1800);
  expect((await state(page)).saves).toBe(saves);
});

test('fonts and typography zones are draft edits: they reach the draft, and nothing live is written before Publish', async ({
  page,
}) => {
  await openBuilder(page);
  const M = (locale() === 'ar' ? arMessages : enMessages).orders.layout;
  const startTabs = page.getByRole('tablist').first().getByRole('tab');
  if (narrow(page))
    await page
      .getByRole('button', { name: L('الهيكل', 'Structure') })
      .first()
      .click();
  await startTabs.nth(1).click();
  await expect(page.getByTestId('theme-settings')).toBeVisible();
  const typography = async () =>
    (await state(page)).draft?.definition as unknown as
      | {
          typography?: {
            fonts?: Array<{ family: string; url: string }>;
            zones?: Record<string, unknown>;
          };
        }
      | undefined;

  // fonts + zones live in the collapsed "Advanced" group of the 3-tier theme pane (#397): open it first
  await page.getByTestId('theme-advanced').getByRole('button').first().click();
  // add a Google font: the whole library goes into the draft
  await page.getByRole('button', { name: M.fonts.addGoogleFont }).click();
  await page.getByLabel(M.fonts.familyNameLabel).fill('Tajawal');
  await page.getByRole('button', { name: M.fonts.addFont, exact: true }).click();
  await expect
    .poll(async () => (await typography())?.typography?.fonts?.map(f => f.family), {
      timeout: 15_000,
    })
    .toEqual(['Tajawal']);
  expect((await typography())?.typography?.fonts?.[0]?.url).toMatch(
    /^https:\/\/fonts\.googleapis\.com\//
  );

  // a typography zone edit is a partial patch for that zone only
  // zone groups and each zone's "more options" are collapsed disclosures (#865): open both, then use the exact-size field
  await page.getByTestId('zone-group-headings').getByRole('button').first().click();
  await page.getByTestId('zone-more-sectionTitle').getByRole('button').first().click();
  const zone = page.locator('[data-zone-key="sectionTitle"]');
  const Z = (locale() === 'ar' ? arMessages : enMessages).zoneEditor;
  await zone.getByLabel(Z.exactSizeLabel).fill('2rem');
  await expect
    .poll(async () => Object.keys((await typography())?.typography?.zones ?? {}), {
      timeout: 15_000,
    })
    .toEqual(['sectionTitle']);

  // the live endpoints were never touched, and the canvas is told about the draft
  expect((await state(page)).liveWrites).toEqual([]);

  // publish promotes the draft; still no direct write to the live theme/typography endpoints
  await page.getByTestId('publish-open').click();
  await page.getByTestId('publish').click();
  await expect.poll(async () => (await state(page)).publishes, { timeout: 15_000 }).toBe(1);
  expect((await state(page)).liveWrites).toEqual([]);
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
  await page.getByTestId('publish-open').click();
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
    await page.getByTestId('publish-open').click();
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
    await page.getByTestId('publish-open').click();
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
  await expect(page.getByTestId('publish-open')).toBeInViewport();
  await expect(page.getByTestId('builder-canvas')).toBeVisible();

  await structure(page);
  await noOverflow('sections tree');
  const startTabs = page.getByRole('tablist').first().getByRole('tab');
  await startTabs.nth(1).click();
  await expect(page.getByTestId('theme-settings')).toBeVisible();
  await noOverflow('theme panel');
  // tabs are sections, theme, ai, history (AI tab since #271): history is the 4th
  await page.locator('#builder-tab-history').click();
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

// ---- Product, collection and cart pages are section documents (Ruling VE-3 amended, VE-12) ----

async function openPage(page: Page, kind: 'product' | 'collection' | 'cart') {
  await page.getByTestId('page-switcher').click();
  await page.getByTestId(`page-option-${kind}`).click();
  await expect(page).toHaveURL(new RegExp(`[?&]page=${kind}`));
  await expect(page.getByTestId('builder')).toBeVisible();
  await structure(page);
}

test('cart page: sections only, the main block is pinned, the canvas loads /cart, no theme tab', async ({
  page,
}) => {
  await openBuilder(page);
  await openPage(page, 'cart');
  expect(await templateIds(page)).toEqual(['cart-main', 'cart-recommendations']);
  // a page of sections: the header and footer belong to every page, not to this one
  await expect(page.getByTestId('tree-group-header')).toHaveCount(0);
  await expect(page.getByTestId('tree-group-footer')).toHaveCount(0);
  // pinned: a lock, no hide and no remove on the main block; the other row keeps both
  const main = page.getByTestId('tree-row-cart-main');
  await expect(page.getByTestId('tree-pinned-cart-main')).toBeVisible();
  await expect(main.getByRole('button', { name: /^(إخفاء|Hide) /u })).toHaveCount(0);
  await main.getByRole('button', { name: /^(خيارات|Options)/ }).click();
  await expect(page.getByRole('menuitem', { name: L('حذف', 'Delete'), exact: true })).toHaveCount(
    0
  );
  await page.keyboard.press('Escape');
  const recs = page.getByTestId('tree-row-cart-recommendations');
  await expect(recs.getByRole('button', { name: /^(إخفاء|Hide) /u })).toHaveCount(1);
  await recs.getByRole('button', { name: /^(خيارات|Options)/ }).click();
  await expect(page.getByRole('menuitem', { name: L('حذف', 'Delete'), exact: true })).toHaveCount(
    1
  );
  await page.keyboard.press('Escape');
  // the theme belongs to the home document only
  // (sections, ai, history: the AI tab exists since #271) and no theme tab
  await expect(page.getByRole('tab')).toHaveCount(3);
  await expect(page.locator('#builder-tab-theme')).toHaveCount(0);
  // the real storefront cart is what the canvas frames
  await expect(page.getByTestId('builder-canvas')).toHaveAttribute('src', /\/cart\?_preview=/);
});

test('product page: the picker offers what belongs here, reorder autosaves and publishes the PRODUCT document only', async ({
  page,
}) => {
  await openBuilder(page);
  await openPage(page, 'product');
  expect(await templateIds(page)).toEqual([
    'product-main',
    'product-faq',
    'product-reviews',
    'product-bundles',
    'product-recommendations',
    'product-related',
  ]);
  await expect(page.getByTestId('builder-canvas')).toHaveAttribute('src', /\/products\/medjool\?/);

  // the picker: a shared section yes, a home-only hero no, a section already on the page is full
  await page.getByTestId('add-section-template').click();
  await expect(page.getByTestId('preset-image-text-0')).toBeEnabled();
  await expect(page.getByTestId('preset-hero-0')).toHaveCount(0);
  await expect(page.getByTestId('preset-product-reviews-0')).toBeDisabled();
  await page.keyboard.press('Escape');

  // reviews up to the top by keyboard: above the main block is allowed
  await page.getByTestId('tree-select-product-reviews').press('Alt+ArrowUp');
  await page.getByTestId('tree-select-product-reviews').press('Alt+ArrowUp');
  expect((await templateIds(page))[0]).toBe('product-reviews');
  await waitSaved(page);
  const draft = (await state(page, 'product')).draft!;
  expect(draft.definition.sections[0].id).toBe('product-reviews');
  // the home document was never touched
  expect((await state(page, 'home')).saves).toBe(0);

  await page.getByTestId('publish-open').click();

  await page.getByTestId('publish').click();
  await expect.poll(async () => (await state(page, 'product')).publishes).toBe(1);
  expect((await state(page, 'home')).publishes).toBe(0);
});

test('switching page saves the unsaved edit first, and the URL carries the page', async ({
  page,
}) => {
  await openBuilder(page);
  await openPage(page, 'product');
  await page.getByTestId('tree-select-product-related').press('Alt+ArrowUp');
  // do not wait for the autosave debounce: the switch itself must flush it
  await page.getByTestId('page-switcher').click();
  await page.getByTestId('page-option-home').click();
  await expect(page).not.toHaveURL(/page=/);
  await expect.poll(async () => (await state(page, 'product')).saves).toBe(1);
  expect((await state(page, 'product')).draft!.definition.sections[4].id).toBe('product-related');
});

// ---- Page-type settings (Task 8e, Ruling VE-13) ----

test("page settings: nothing selected shows the page's own settings; a change is a draft edit of that page only", async ({
  page,
}) => {
  await openBuilder(page);
  await openPage(page, 'product');
  // the panel needs the end pane on a phone
  if (narrow(page))
    await page
      .getByRole('button', { name: L('الإعدادات', 'Settings') })
      .first()
      .click();
  await expect(page.getByTestId('page-settings-panel')).toBeVisible();
  const group = page.getByTestId('page-settings-productDetailPage');
  await group.locator('#setting-density').selectOption('compact');
  await waitSaved(page);
  const draft = (await state(page, 'product')).draft!;
  expect((draft.definition as any).siteSettings.productDetailPage).toEqual({ density: 'compact' });
  // the canvas received the draft with the setting (it repaints from it)
  await expect
    .poll(async () =>
      canvas(page)
        .locator('body')
        .evaluate(() => (window as any).__doc?.siteSettings?.productDetailPage?.density)
    )
    .toBe('compact');
  // the home document was not touched
  expect((await state(page, 'home')).saves).toBe(0);
  // selecting a section swaps the panel for the section's settings; "Page settings" brings it back
  await structure(page);
  await page.getByTestId('tree-select-product-faq').click();
  await settings(page);
  await structure(page);
  await page.getByTestId('open-page-settings').click();
  await expect(page.getByTestId('page-settings-panel')).toBeVisible();
});

test('page settings: filters on the collection page start from the baseline, cart has cart and checkout, home has cards and image shapes', async ({
  page,
}) => {
  await openBuilder(page);
  await openPage(page, 'collection');
  if (narrow(page))
    await page
      .getByRole('button', { name: L('الإعدادات', 'Settings') })
      .first()
      .click();
  const filters = page.getByTestId('page-settings-filterSidebar');
  await filters.getByRole('button').first().click();
  await filters.getByRole('switch').first().click();
  await waitSaved(page);
  // Poll the server-side draft instead of reading it once: `save-status` still says "saved" from the page
  // open until the debounced autosave of THIS edit has marked it dirty, so on a slower runner the single read
  // ran before any collection draft existed (null; red on 4 of 6 viewports in run 40234150651, Ruling ITEST-6).
  await expect
    .poll(
      async () =>
        ((await state(page, 'collection')).draft?.definition as any)?.siteSettings?.filterSidebar,
      {
        timeout: 15_000,
      }
    )
    .toEqual({ enabled: false, defaultOpen: true });

  await openPage(page, 'cart');
  if (narrow(page))
    await page
      .getByRole('button', { name: L('الإعدادات', 'Settings') })
      .first()
      .click();
  await expect(page.getByTestId('page-settings-cartPage')).toBeVisible();
  await expect(page.getByTestId('page-settings-checkoutPage')).toBeVisible();
  // the cards belong to the home page: this page points there
  await page.getByTestId('page-settings-to-home').click();
  await expect(page).not.toHaveURL(/page=/);
  await expect(page.getByTestId('builder')).toBeVisible();
  if (narrow(page))
    await page
      .getByRole('button', { name: L('الإعدادات', 'Settings') })
      .first()
      .click();
  await expect(page.getByTestId('page-settings-productCardDefaults')).toBeVisible();
  await expect(page.getByTestId('page-settings-sizing')).toBeVisible();
  await expect(page.getByTestId('page-settings-bottomBar')).toBeVisible();
});

// ---- Change the look from the editor, with a preview (Task 9, Ruling EP-3) ----

// The radio input is a transparent overlay under the preview image (#865), so click its label card like a user.
async function pickVitrine(page: Page) {
  await page
    .locator('label')
    .filter({ has: page.getByRole('radio', { name: /Vitrine|فاترينة/ }) })
    .click();
}

async function openLookPane(page: Page) {
  // the button also opens the right pane on a narrow screen
  await page.getByTestId('open-look-switch').click();
  await expect(page.getByTestId('look-switch-pane')).toBeVisible();
}

test('look switch: the proposal shows in the same canvas, the real page is untouched until Apply', async ({
  page,
}) => {
  await openBuilder(page);
  await openLookPane(page);
  const realDoc = await canvas(page)
    .locator('body')
    .evaluate(() => JSON.stringify((window as any).__doc));
  // pick Vitrine and preview
  await pickVitrine(page);
  await page.getByTestId('look-preview').click();
  await expect(page.getByTestId('look-preview-bar')).toBeVisible();
  // the canvas now renders the proposed document (a different section list or settings)
  await expect
    .poll(async () =>
      canvas(page)
        .locator('body')
        .evaluate(() => JSON.stringify((window as any).__doc))
    )
    .not.toBe(realDoc);
  // the report says the content stays; nothing was saved to the real page yet
  if (narrow(page))
    await page
      .getByRole('button', { name: L('الإعدادات', 'Settings') })
      .first()
      .click();
  await expect(page.getByTestId('look-report')).toContainText(/(section|قسم)/);
  expect((await state(page)).look).toBeNull();
  expect((await state(page)).saves).toBe(0);

  // Keep editing: the canvas is back on the real page
  await page.getByTestId('look-bar-keep').click();
  await expect(page.getByTestId('look-preview-bar')).toHaveCount(0);
  await expect
    .poll(async () =>
      canvas(page)
        .locator('body')
        .evaluate(() => JSON.stringify((window as any).__doc))
    )
    .toBe(realDoc);
});

test('look switch: Apply writes the proposal and the editor reloads it; a moved page is refused, not applied', async ({
  page,
}) => {
  await openBuilder(page);
  await openLookPane(page);
  await pickVitrine(page);
  await page.getByTestId('look-preview').click();
  await expect(page.getByTestId('look-preview-bar')).toBeVisible();
  // the page moves under the preview (another editor saved)
  await page.request.post(`${API}/__test/bump`);
  await page.getByTestId('look-bar-apply').click();
  // Apply asks first (plan F60): the confirm dialog names what happens, then applies
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('look-preview-bar')).toHaveCount(0);
  expect((await state(page)).look).toBeNull();

  // the gallery opens again for the next preview
  await expect(page.getByTestId('look-switch-pane')).toBeVisible();
  await pickVitrine(page);
  await page.getByTestId('look-preview').click();
  await expect(page.getByTestId('look-preview-bar')).toBeVisible();
  await page.getByTestId('look-bar-apply').click();
  // Apply asks first (plan F60): the confirm dialog names what happens, then applies
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('look-preview-bar')).toHaveCount(0);
  await expect.poll(async () => (await state(page)).look).toBe('qamar.vitrine');
});
