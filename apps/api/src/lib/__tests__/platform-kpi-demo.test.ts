import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { platformKpiOrderWhere, DEMO_ORDER_PREFIX } from '../demo-store';

describe('STORE-QA-2 platform KPIs exclude demo data', () => {
  it('order filter excludes seeded DEMO- orders but stays scoped to the store', () => {
    const w = platformKpiOrderWhere('s1');
    expect(w.storeId).toBe('s1');
    expect(w.NOT.orderNumber.startsWith).toBe(DEMO_ORDER_PREFIX);
    expect(DEMO_ORDER_PREFIX).toBe('DEMO-');
  });

  it('GET /admin/dashboard counts + recent orders go through the one rule and skip showroom stores', () => {
    const src = readFileSync(join(__dirname, '../../routes/admin.routes.ts'), 'utf8');
    const start = src.indexOf("'/dashboard',");
    const block = src.slice(start, start + 4500);
    expect(block).toContain('isDemoStore(storeId)');
    expect(block).toContain('isDemoStore(currentStoreId())');
    expect(block.match(/platformKpiOrderWhere\(/g)?.length).toBe(2);
  });
});
