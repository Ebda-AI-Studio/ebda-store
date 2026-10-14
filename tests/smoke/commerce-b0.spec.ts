import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Phase B0 commerce flow, driven against the LOCAL seeded stack (never production):
 *   PDP (swatches, struck combo, facts, delivery chip, size guide, required personalisation)
 *   -> sticky add-to-cart bar -> cart (two personalised lines + sticky total) -> COD checkout
 *   -> receipt-printer success page -> the same order through the admin API.
 *
 * Needs the local stack from `.superpowers/.../local-stack/README.md` (API :4100, web via the
 * host-shim proxy :3100, store `b0-minimal`, the "Linen Abaya" fixture). When the stack is not
 * reachable the whole file SKIPS, so the default `playwright test` smoke run against a deployed
 * environment is unaffected. It mutates the local DB only: it creates one size chart, edits the
 * Linen Abaya through the admin API, places one COD order, and restores the product afterwards.
 *
 * Env (all optional):
 *   B0_WEB_URL      storefront origin           default http://b0-minimal.localhost:3100
 *   B0_API_URL      API origin + /api/v1        default http://127.0.0.1:4100/api/v1
 *   B0_STORE_SLUG   store slug                  default b0-minimal
 *   B0_PRODUCT_SLUG product slug                default linen-abaya
 *   B0_OWNER_EMAIL / B0_OWNER_PASSWORD          else read from B0_CREDENTIALS_FILE
 *   B0_CREDENTIALS_FILE                         default the local-stack CREDENTIALS.local (chmod 600)
 *
 * Step 8 (admin order view) is asserted through the admin API the order page calls
 * (`GET /stores/:id/orders/:orderId`); the admin UI itself is not driven here.
 */

const WEB = process.env.B0_WEB_URL ?? 'http://b0-minimal.localhost:3100';
const API = process.env.B0_API_URL ?? 'http://127.0.0.1:4100/api/v1';
const STORE_SLUG = process.env.B0_STORE_SLUG ?? 'b0-minimal';
const PRODUCT_SLUG = process.env.B0_PRODUCT_SLUG ?? 'linen-abaya';
const CREDS_FILE =
  process.env.B0_CREDENTIALS_FILE ??
  resolve(
    __dirname,
    '../../.superpowers/sdd/2026-10-14-phase-b0-platform-commerce/local-stack/CREDENTIALS.local'
  );

function ownerCredentials(): { email: string; password: string } | null {
  let email = process.env.B0_OWNER_EMAIL;
  let password = process.env.B0_OWNER_PASSWORD;
  if ((!email || !password) && existsSync(CREDS_FILE)) {
    const raw = readFileSync(CREDS_FILE, 'utf8');
    email ??= /^B0_OWNER_EMAIL=(.+)$/m.exec(raw)?.[1];
    password ??= /^B0_OWNER_PASSWORD=(.+)$/m.exec(raw)?.[1];
  }
  return email && password ? { email, password } : null;
}

type Json = Record<string, any>;
let token = '';
let storeId = '';
let productId = '';
let createdChartId = '';
let codCreated = false;
let codWasDisabled = false;
let originalProduct: Json = {};
let stackUp = false;
let orderId = '';

async function adminFetch(
  request: APIRequestContext,
  method: 'get' | 'post' | 'put' | 'delete',
  path: string,
  data?: Json
) {
  const res = await request[method](`${API}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    ...(data ? { data } : {}),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status(), body: body as Json };
}

test.describe.configure({ mode: 'serial', retries: 0 });

test.describe('commerce b0 flow @local-stack', () => {
  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext();
    try {
      const ping = await request.get(`${API}/health`, { timeout: 4_000 }).catch(() => null);
      const web = await request.get(WEB, { timeout: 8_000 }).catch(() => null);
      stackUp = !!ping && ping.status() < 500 && !!web && web.status() < 500;
      const creds = ownerCredentials();
      if (!stackUp || !creds) {
        stackUp = false;
        return;
      }

      const login = await request.post(`${API}/auth/login`, { data: creds });
      expect(login.status(), 'owner login').toBe(200);
      token = (await login.json()).data.accessToken;

      const stores = await adminFetch(request, 'get', '/stores');
      storeId = stores.body.data.stores.find((s: Json) => s.slug === STORE_SLUG)?.id;
      expect(storeId, `store ${STORE_SLUG}`).toBeTruthy();

      const pub = await request.get(`${API}/public/products/${PRODUCT_SLUG}`, {
        headers: { 'x-store-id': storeId },
      });
      const pubBody = await pub.json();
      productId = (pubBody.data.product ?? pubBody.data).id;
      expect(productId, `product ${PRODUCT_SLUG}`).toBeTruthy();

      const before = await adminFetch(request, 'get', `/stores/${storeId}/products/${productId}`);
      const p = before.body.data.product as Json;
      originalProduct = {
        facts: p.facts ?? [],
        leadTimeDays: p.leadTimeDays ?? null,
        personalisation: p.personalisation ?? null,
        sizeChartId: p.sizeChartId ?? null,
      };

      // A size chart with >= 2 rows, linked to the product.
      const chart = await adminFetch(request, 'post', `/stores/${storeId}/size-charts`, {
        name: 'B0 e2e abaya chart',
        nameAr: 'مقاسات عباية (اختبار)',
        unit: 'cm',
        columns: [
          { label: 'Size', labelAr: 'المقاس' },
          { label: 'Bust', labelAr: 'الصدر' },
          { label: 'Length', labelAr: 'الطول' },
        ],
        rows: [
          ['S', '92', '52'],
          ['M', '98', '54'],
          ['L', '104', '56'],
        ],
        note: '',
        noteAr: '',
      });
      expect(chart.status, JSON.stringify(chart.body)).toBe(201);
      createdChartId = chart.body.data.id;

      // Facts, required personalisation, lead time and the chart, through the real admin PUT.
      const put = await adminFetch(request, 'put', `/stores/${storeId}/products/${productId}`, {
        facts: [
          { key: 'Fabric', keyAr: 'الخامة', value: 'Linen', valueAr: 'كتان', onCard: true },
          {
            key: 'Care',
            keyAr: 'العناية',
            value: 'Hand wash',
            valueAr: 'غسيل يدوي',
            onCard: false,
          },
          { key: 'Origin', keyAr: 'المنشأ', value: 'Egypt', valueAr: 'مصر', onCard: false },
        ],
        leadTimeDays: 5,
        personalisation: {
          enabled: true,
          required: true,
          label: 'Name for embroidery',
          labelAr: 'الاسم للتطريز',
          maxLength: 12,
        },
        sizeChartId: createdChartId,
      });
      expect(put.status, JSON.stringify(put.body)).toBe(200);

      // The store needs cash on delivery enabled for the COD checkout step.
      const cod = await adminFetch(request, 'post', `/payment-settings/store/${storeId}`, {
        provider: 'cod',
        isEnabled: true,
        isDefault: true,
        settings: {},
      });
      if (cod.status === 201) {
        codCreated = true;
      } else if (cod.status === 409) {
        const upd = await adminFetch(request, 'put', `/payment-settings/store/${storeId}/cod`, {
          isEnabled: true,
        });
        expect(upd.status, JSON.stringify(upd.body)).toBe(200);
        codWasDisabled = true;
      } else {
        expect(cod.status, JSON.stringify(cod.body)).toBe(201);
      }
    } finally {
      await request.dispose();
    }
  });

  test.afterAll(async ({ playwright }) => {
    if (!stackUp || !token) return;
    const request = await playwright.request.newContext();
    try {
      if (productId) {
        await adminFetch(request, 'put', `/stores/${storeId}/products/${productId}`, {
          facts: originalProduct.facts,
          leadTimeDays: originalProduct.leadTimeDays,
          personalisation: originalProduct.personalisation,
          sizeChartId: originalProduct.sizeChartId,
        });
      }
      if (createdChartId) {
        await adminFetch(request, 'delete', `/stores/${storeId}/size-charts/${createdChartId}`);
      }
      if (codCreated) {
        await adminFetch(request, 'delete', `/payment-settings/store/${storeId}/cod`);
      } else if (codWasDisabled) {
        await adminFetch(request, 'put', `/payment-settings/store/${storeId}/cod`, {
          isEnabled: false,
        });
      }
    } finally {
      await request.dispose();
    }
  });

  test.beforeEach(() => {
    test.skip(!stackUp, 'local B0 stack (API :4100 + web :3100 + owner credentials) not reachable');
  });

  test.use({ viewport: { width: 390, height: 844 }, baseURL: WEB });

  test('pdp -> sticky add -> cart -> cod checkout -> receipt -> admin order', async ({
    page,
    context,
    request,
  }) => {
    test.setTimeout(240_000);
    const host = new URL(WEB).hostname;
    await context.addCookies([
      { name: 'force-language', value: 'ar', domain: host, path: '/' },
      {
        name: 'force-cookie-consent',
        value: encodeURIComponent(JSON.stringify({ v: 1, marketing: false, analytics: false })),
        domain: host,
        path: '/',
      },
    ]);

    // 1. The PDP.
    await page.goto(`/products/${PRODUCT_SLUG}`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();

    // 2. Swatches, the struck sold-out combo, facts, delivery chip, size guide.
    const teal = page.getByRole('button', { name: 'أزرق مخضر' });
    const rose = page.getByRole('button', { name: 'وردي' });
    await expect(teal).toBeVisible();
    await expect(rose).toBeVisible();
    await expect(page.getByRole('button', { name: 'أسود' })).toBeVisible();

    await teal.click();
    await page.getByRole('button', { name: 'M', exact: true }).click();
    const struck = page.getByRole('button', { name: '56 سم' });
    await expect(struck).toBeDisabled();
    await expect(struck).toHaveClass(/line-through/);

    const facts = page.getByRole('region', { name: 'تفاصيل المنتج' });
    await expect(facts).toContainText('الخامة');
    await expect(facts).toContainText('كتان');
    await expect(facts).toContainText('العناية');
    await expect(facts).toContainText('المنشأ');

    await expect(page.getByTestId('delivery-chip')).toContainText('يوصلك');

    await page.getByRole('button', { name: 'دليل المقاسات' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    expect(await dialog.locator('tbody tr').count()).toBeGreaterThanOrEqual(2);
    await dialog.getByRole('button', { name: 'إغلاق' }).click();
    await expect(dialog).toBeHidden();

    // Pick a purchasable combination: Rose / M / 54.
    await rose.click();
    await page.getByRole('button', { name: '54 سم' }).click();

    // 3. Required personalisation: the button is disabled and the message is shown.
    const field = page.locator('input[maxlength="12"]');
    // The buy row's primary button is the sibling just before the wishlist toggle.
    const mainAdd = page
      .getByRole('button', { name: 'Add to wishlist' })
      .first()
      .locator('xpath=preceding-sibling::button[1]');
    await expect(field).toBeVisible();
    await expect(mainAdd).toBeDisabled();
    await expect(page.getByText('اكتب الاسم للتطريز الأول')).toBeVisible();

    // 4. Type Sara and add; then the sticky bar adds Omar.
    await field.fill('Sara');
    await expect(mainAdd).toBeEnabled();
    await mainAdd.click();
    await expect(page.getByText(/تمت الإضافة|اتضاف|أضيف|السلة/).first()).toBeVisible();

    await field.fill('Omar');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const sticky = page.getByTestId('sticky-atc');
    await expect(sticky).toBeVisible();
    await expect(page.locator('body')).toHaveAttribute('data-sticky-atc', '1');
    await sticky.getByRole('button').click();

    // 5. The cart: two lines, one note each, and the sticky total bar.
    await page.goto('/cart', { waitUntil: 'networkidle' });
    // CartLineNote renders `✎ <bdi>note</bdi>` (the pencil is its own aria-hidden span).
    const noteLine = (name: string) =>
      page.locator('p', { has: page.locator(`bdi:text-is("${name}")`) });
    await expect(noteLine('Sara')).toContainText('✎');
    await expect(noteLine('Omar')).toContainText('✎');
    await expect(page.locator('p:has(> span[aria-hidden="true"]:text-is("✎ "))')).toHaveCount(2);
    await expect(page.getByTestId('sticky-cart-total')).toBeVisible();

    // 6. COD checkout.
    await page.getByTestId('sticky-cart-total').getByRole('link').click();
    await page.waitForURL(/\/checkout/);
    await fillCheckout(page);
    await page.getByRole('button', { name: 'المتابعة للدفع' }).click();
    await page.getByText('الدفع عند الاستلام').first().click();
    await page
      .getByRole('button', { name: /تأكيد الطلب|إتمام الطلب|إتمام|تأكيد/ })
      .last()
      .click();
    await page.waitForURL(/\/checkout\/success/, { timeout: 60_000 });
    orderId = new URL(page.url()).searchParams.get('orderId') ?? '';

    // 7. The receipt: both notes, cash on delivery, never "paid".
    const paper = page.getByTestId('receipt-paper');
    await expect(paper).toBeVisible({ timeout: 30_000 });
    await expect(paper).toContainText('Sara');
    await expect(paper).toContainText('Omar');
    await expect(page.getByTestId('receipt-payment-label')).toContainText('الدفع عند الاستلام');
    await expect(page.getByTestId('receipt-line')).toHaveCount(2);
    await expect(page.locator('main')).not.toContainText('المدفوع');

    // 8. The admin order (API the admin order page calls; the admin UI is not driven here).
    if (!orderId) {
      const num = (await page.getByTestId('receipt-order-number').innerText()).replace('#', '');
      const list = await adminFetch(request, 'get', `/stores/${storeId}/orders?search=${num}`);
      orderId = (list.body.data.orders ?? list.body.data)[0]?.id;
    }
    expect(orderId, 'order id from the success URL or the order list').toBeTruthy();
    const order = await adminFetch(request, 'get', `/stores/${storeId}/orders/${orderId}`);
    expect(order.status).toBe(200);
    const o = (order.body.data.order ?? order.body.data) as Json;
    const items = (o.items as Json[]).filter(i => i.personalisation);
    expect(items.map(i => i.personalisation).sort()).toEqual(['Omar', 'Sara']);
    for (const i of items) {
      expect(i.variantName, 'variantName snapshot').toBeTruthy();
      expect(String(i.variantName)).toContain('وردي');
    }
  });
});

async function fillCheckout(page: Page) {
  await page.locator('input[autocomplete="given-name"]').fill('Test');
  await page.locator('input[autocomplete="family-name"]').fill('Buyer');
  await page.locator('input[autocomplete="tel"]').fill('+201012345678');
  await page.locator('input[autocomplete="email"]').fill('b0-e2e@example.test');
  await pickCombobox(page, 'المحافظة', 'القاهرة');
  await pickCombobox(page, 'المنطقة', undefined);
  await page.locator('input[autocomplete="address-line1"]').fill('Test Street');
  await page.getByLabel(/رقم المبنى/).fill('12');
}

async function pickCombobox(page: Page, placeholder: string, query?: string) {
  const input = page.getByPlaceholder(placeholder);
  await input.click();
  if (query) await input.fill(query);
  await page.getByRole('option').first().click();
}
