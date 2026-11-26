/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it, beforeAll } from 'vitest';
import { bootstrapMerchant, call, type Merchant } from './merchant-fixture';

// Ported from tests/integration/size-charts.test.ts (Postgres, strict RLS, express) to the built Worker + StoreDO: CRUD + tenant
// isolation, validation (ragged chart / unknown unit), linking another store's chart is refused, the PDP resolves product chart else
// category chart (nested per-category chart not repeated) and a chart write/delete is visible at once, deleting a chart that
// products/categories point at is a 200 that nulls both, the public list is the resolved store's own. "Deleting a product / category /
// store never trips an FK": product and category deletes are exercised through the routes with a chart linked.
const abaya = {
  name: '',
  nameAr: 'عباية',
  unit: 'cm',
  columns: [
    { label: 'Size', labelAr: 'المقاس' },
    { label: '', labelAr: 'الطول' },
    { label: 'Bust', labelAr: 'الصدر' },
  ],
  rows: [
    ['S', '52', '90'],
    ['M', '54', '96'],
    ['L', '56', '102'],
  ],
  note: '',
  noteAr: 'القياسات بالسنتيمتر',
};
const uid = () => crypto.randomUUID().slice(0, 8);
let A: Merchant;
let B: Merchant;

const charts = (m: Merchant) => `/stores/${m.storeId}/size-charts`;
const mkChart = async (m: Merchant, over: object = {}) => {
  const r = await call(charts(m), { method: 'POST', token: m.token, body: { ...abaya, ...over } });
  expect(r.status, r.text).toBe(201);
  return r.json.data.id as string;
};
const product = async (m: Merchant, extra: object = {}) => {
  const r = await call(`/stores/${m.storeId}/products`, {
    method: 'POST',
    token: m.token,
    body: { name: `Linen Abaya ${uid()}`, price: 5000, status: 'active', ...extra },
  });
  expect(r.status, r.text).toBe(201);
  return (r.json.data.product ?? r.json.data) as { id: string; slug: string };
};
const pdp = (m: Merchant, slug: string) =>
  call(`/public/products/${slug}`, { headers: { 'x-store-id': m.storeId } });

describe('size charts on the Worker', () => {
  beforeAll(async () => {
    A = await bootstrapMerchant('szc-a');
    B = await bootstrapMerchant('szc-b');
  }, 120_000);

  it('crud + tenant isolation', async () => {
    const c = await call(charts(A), { method: 'POST', token: A.token, body: abaya });
    expect(c.status, c.text).toBe(201);
    const id = c.json.data.id as string;
    expect(c.json.data.rows).toEqual(abaya.rows);
    const list = await call(charts(A), { token: A.token });
    expect(list.status).toBe(200);
    expect(list.json.data.sizeCharts.map((s: { id: string }) => s.id)).toContain(id);
    const put = await call(`${charts(A)}/${id}`, {
      method: 'PUT',
      token: A.token,
      body: { ...abaya, unit: 'in' },
    });
    expect(put.status, put.text).toBe(200);
    expect(put.json.data.unit).toBe('in');
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const r = await call(`${charts(B)}/${id}`, {
        method,
        token: B.token,
        ...(method === 'PUT' ? { body: abaya } : {}),
      });
      expect(r.status, `${method} ${r.text}`).toBe(404);
    }
    expect((await call(charts(A), { token: B.token })).status).toBe(403);
    expect((await call(charts(A))).status).toBe(401);
    expect((await call(`${charts(A)}/${id}`, { token: A.token })).status).toBe(200); // still there
  });

  it('rejects a ragged chart and an unknown unit (400)', async () => {
    for (const bad of [
      { ...abaya, rows: [['S', '52']] },
      { ...abaya, unit: 'mm' },
      { ...abaya, name: '', nameAr: '' },
    ]) {
      expect((await call(charts(A), { method: 'POST', token: A.token, body: bad })).status).toBe(
        400
      );
    }
  });

  it("a product or category cannot link another store's chart", async () => {
    const bChart = await mkChart(B);
    const p = await product(A);
    const r = await call(`/stores/${A.storeId}/products/${p.id}`, {
      method: 'PUT',
      token: A.token,
      body: { sizeChartId: bChart },
    });
    expect(r.status, r.text).toBe(404);
    expect(r.json.error.code).toBe('SIZE_CHART_NOT_FOUND');
    const cat = await call(`/stores/${A.storeId}/categories`, {
      method: 'POST',
      token: A.token,
      body: { name: `Abayas ${uid()}`, sizeChartId: bChart },
    });
    expect(cat.status, cat.text).toBe(404);
  });

  it('pdp resolves product chart, else category chart; deleting a chart nulls references; delete of linked product/category is clean', async () => {
    const catChart = await mkChart(A, { nameAr: 'جدول القسم' });
    const ownChart = await mkChart(A, { nameAr: 'جدول المنتج' });
    const cat = await call(`/stores/${A.storeId}/categories`, {
      method: 'POST',
      token: A.token,
      body: { name: `Abayas ${uid()}` },
    });
    expect(cat.status, cat.text).toBe(201);
    const categoryId = (cat.json.data.category ?? cat.json.data).id as string;
    const p = await product(A, { categories: [categoryId] });

    let r = await pdp(A, p.slug);
    expect(r.status, r.text).toBe(200);
    expect(r.json.data.product.sizeChart).toBeNull();

    expect(
      (
        await call(`/stores/${A.storeId}/categories/${categoryId}`, {
          method: 'PUT',
          token: A.token,
          body: { sizeChartId: catChart },
        })
      ).status
    ).toBe(200);
    r = await pdp(A, p.slug);
    expect(r.json.data.product.sizeChart.id).toBe(catChart);
    expect(r.json.data.product.sizeChart.nameAr).toBe('جدول القسم');
    expect(r.json.data.product.sizeChart.rows).toEqual(abaya.rows);
    expect(r.json.data.product.categories[0].category).not.toHaveProperty('sizeChart');

    expect(
      (
        await call(`/stores/${A.storeId}/products/${p.id}`, {
          method: 'PUT',
          token: A.token,
          body: { sizeChartId: ownChart },
        })
      ).status
    ).toBe(200);
    r = await pdp(A, p.slug);
    expect(r.json.data.product.sizeChart.id).toBe(ownChart);

    expect(
      (
        await call(`${charts(A)}/${ownChart}`, {
          method: 'PUT',
          token: A.token,
          body: { ...abaya, nameAr: 'جدول معدل' },
        })
      ).status
    ).toBe(200);
    expect((await pdp(A, p.slug)).json.data.product.sizeChart.nameAr).toBe('جدول معدل'); // a chart write busts the cached PDP

    expect(
      (await call(`${charts(A)}/${ownChart}`, { method: 'DELETE', token: A.token })).status
    ).toBe(200);
    r = await pdp(A, p.slug);
    expect(r.status).toBe(200);
    expect(r.json.data.product.sizeChart.id).toBe(catChart); // falls back to the category's

    expect(
      (await call(`${charts(A)}/${catChart}`, { method: 'DELETE', token: A.token })).status
    ).toBe(200);
    r = await pdp(A, p.slug);
    expect(r.status).toBe(200);
    expect(r.json.data.product.sizeChart).toBeNull();

    // omitted key leaves the link alone; an explicit null clears it
    const again = await mkChart(A, { nameAr: 'جدول تالت' });
    await call(`/stores/${A.storeId}/products/${p.id}`, {
      method: 'PUT',
      token: A.token,
      body: { sizeChartId: again },
    });
    await call(`/stores/${A.storeId}/products/${p.id}`, {
      method: 'PUT',
      token: A.token,
      body: { name: 'Renamed' },
    });
    expect((await pdp(A, p.slug)).json.data.product.sizeChart.id).toBe(again);
    await call(`/stores/${A.storeId}/products/${p.id}`, {
      method: 'PUT',
      token: A.token,
      body: { sizeChartId: null },
    });
    expect((await pdp(A, p.slug)).json.data.product.sizeChart).toBeNull();

    // deleting a product / category that still points at a chart never trips an FK, and the chart survives
    const keep = await mkChart(A, { nameAr: 'باقي' });
    const p2 = await product(A, { sizeChartId: keep });
    const cat2 = await call(`/stores/${A.storeId}/categories`, {
      method: 'POST',
      token: A.token,
      body: { name: `Gone ${uid()}`, sizeChartId: keep },
    });
    expect(cat2.status, cat2.text).toBe(201);
    const del1 = await call(`/stores/${A.storeId}/products/${p2.id}`, {
      method: 'DELETE',
      token: A.token,
    });
    expect(del1.status, del1.text).toBeLessThan(300);
    const del2 = await call(
      `/stores/${A.storeId}/categories/${(cat2.json.data.category ?? cat2.json.data).id}`,
      { method: 'DELETE', token: A.token }
    );
    expect(del2.status, del2.text).toBeLessThan(300);
    expect((await call(`${charts(A)}/${keep}`, { token: A.token })).status).toBe(200);
  });

  it("GET /public/size-charts lists only the resolved store's charts", async () => {
    const r = await call('/public/size-charts', { headers: { 'x-store-id': A.storeId } });
    expect(r.status, r.text).toBe(200);
    const ids: string[] = r.json.data.sizeCharts.map((c: { id: string }) => c.id);
    expect(ids.length).toBeGreaterThan(0);
    const own = await call(charts(A), { token: A.token });
    expect(new Set(ids)).toEqual(
      new Set(own.json.data.sizeCharts.map((c: { id: string }) => c.id))
    );
    const rb = await call('/public/size-charts', { headers: { 'x-store-id': B.storeId } });
    expect(rb.json.data.sizeCharts.every((c: { id: string }) => !ids.includes(c.id))).toBe(true);
  });
});
