/**
 * Visual editor Task 13: the keyboard path, end to end in the admin (the canvas is the contract
 * fake). Tree Enter -> canvas focus, Esc -> tree, Alt+Arrow moves and is announced in the live
 * region, drawers below lg trap focus and return it, and axe finds no serious or critical
 * violation on the editor chrome (axe-core is already in the tree via @ebda/site-kit -> lighthouse).
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const API = `http://localhost:${process.env.MOCK_API_PORT || 4510}/api/v1`;
const STORE_ID = '0a0b0c0d-0000-4000-8000-00000000e2e0';
const CANVAS_ORIGIN = 'https://e2e-store.ebda.app';
const FAKE_CANVAS = readFileSync(join(__dirname, 'fake-canvas.html'), 'utf8');
const AXE = join(process.cwd(), 'node_modules/axe-core/axe.min.js');

const ar = () => test.info().project.name.startsWith('ar');
const L = (a: string, e: string) => (ar() ? a : e);
const narrow = (page: Page) => (page.viewportSize()?.width ?? 1280) < 1024;

async function open(page: Page) {
  await page.request.post(`${API}/__test/reset`);
  await page
    .context()
    .addCookies([{ name: 'admin-lang', value: ar() ? 'ar' : 'en', url: 'http://localhost:3101' }]);
  await page.addInitScript(() => localStorage.setItem('accessToken', 'e2e'));
  await page.route(`${CANVAS_ORIGIN}/**`, r =>
    r.fulfill({ contentType: 'text/html', body: FAKE_CANVAS })
  );
  await page.goto(`/stores/${STORE_ID}/builder`);
  await expect(page.getByTestId('builder')).toBeVisible({ timeout: 60_000 });
}
const structureButton = (page: Page) =>
  page.getByRole('button', { name: L('الهيكل', 'Structure') }).first();

test('Enter on a tree row hands focus to the canvas; Esc brings it back; Alt+Arrow is announced', async ({
  page,
}) => {
  await open(page);
  if (narrow(page)) await structureButton(page).click();
  const row = page.getByTestId('tree-select-categories');
  await row.focus();
  await row.press('Enter');
  // focus is now inside the canvas frame
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid')))
    .toBe('builder-canvas');
  await page.frameLocator('[data-testid="builder-canvas"]').locator('body').press('Escape');
  await expect(page.getByTestId('tree-select-categories')).toBeFocused();

  // Alt+ArrowUp: the section moves and the live region says so, in the admin's language
  await page.getByTestId('tree-select-categories').press('Alt+ArrowDown');
  await expect(page.getByTestId('builder-live')).toContainText(L('اتنقل القسم', 'Moved'));
  await expect(page.getByTestId('builder-live')).toContainText(L('لتحت', 'down'));
  await page.getByTestId('tree-select-categories').press('Alt+ArrowUp');
  await expect(page.getByTestId('builder-live')).toContainText(L('لفوق', 'up'));
});

test('a drawer below lg traps focus, closes on Esc and returns focus to its opener', async ({
  page,
}) => {
  test.skip(!(page.viewportSize()!.width < 1024), 'drawers exist below lg only');
  await open(page);
  const opener = structureButton(page);
  await opener.focus();
  await opener.press('Enter');
  const drawer = page.getByRole('complementary', { name: L('الهيكل', 'Structure') }).first();
  await expect(drawer).toBeVisible();
  // Tab many times: focus never leaves the drawer
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    expect(await drawer.evaluate(el => el.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(opener).toBeFocused();
});

test('axe: no serious or critical violation on the editor chrome', async ({ page }) => {
  await open(page);
  if (narrow(page)) await structureButton(page).click();
  await page.addScriptTag({ content: readFileSync(AXE, 'utf8') });
  const bad = await page.evaluate(async () => {
    const r = await (window as any).axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      // the canvas iframe is the storefront (audited by its own specs)
      exclude: [['[data-testid="builder-canvas"]']],
    });
    return r.violations
      .filter((v: any) => v.impact === 'serious' || v.impact === 'critical')
      .map((v: any) => `${v.id}: ${v.nodes.length} node(s) ${v.nodes[0]?.target}`);
  });
  expect(bad).toEqual([]);
});
