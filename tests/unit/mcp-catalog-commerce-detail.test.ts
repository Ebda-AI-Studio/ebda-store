import { describe, it, expect, vi, beforeEach } from 'vitest';

const getPublicById = vi.fn();
vi.mock('../../apps/api/src/services/product.service', () => ({
  ProductService: { getPublicById: (...a: unknown[]) => getPublicById(...a), listPublic: vi.fn() },
}));

import { registerCatalogTools } from '../../apps/api/src/mcp/tools/catalog.tools';

type Handler = (args: { productId: string }) => Promise<{ content: Array<{ text: string }> }>;

function getProductHandler(): Handler {
  const tools = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _def: unknown, h: Handler) => void tools.set(name, h),
  };
  registerCatalogTools(server as never, { id: 's1', currency: 'EGP' } as never);
  return tools.get('get_product')!;
}

const base = {
  id: 'p1',
  name: 'Linen Abaya',
  nameAr: 'عباية كتان',
  price: 149000,
  inStock: true,
  variants: [],
  images: [],
};

async function call(extra: Record<string, unknown>) {
  getPublicById.mockResolvedValue({ ...base, ...extra });
  const res = await getProductHandler()({ productId: 'p1' });
  return JSON.parse(res.content[0].text);
}

describe('buyer MCP get_product carries the B0 commerce fields', () => {
  beforeEach(() => getPublicById.mockReset());

  it('exposes facts, required personalisation, lead time and the size chart', async () => {
    const out = await call({
      facts: [{ key: 'Fabric', keyAr: 'الخامة', value: 'Linen', valueAr: 'كتان', onCard: true }],
      personalisation: {
        enabled: true,
        required: true,
        label: '',
        labelAr: 'الاسم للتطريز',
        maxLength: 12,
      },
      leadTimeDays: 5,
      sizeChart: {
        id: 'c1',
        name: 'Abaya',
        nameAr: '',
        unit: 'cm',
        columns: [
          { label: 'Size', labelAr: 'المقاس' },
          { label: 'Length', labelAr: 'الطول' },
        ],
        rows: [['S', '52']],
        note: '',
        noteAr: '',
      },
    });
    expect(out.facts).toEqual([
      { name: 'Fabric', name_ar: 'الخامة', value: 'Linen', value_ar: 'كتان' },
    ]);
    expect(out.personalisation).toEqual({
      required: true,
      label_ar: 'الاسم للتطريز',
      max_length: 12,
    });
    expect(out.lead_time_days).toBe(5);
    expect(out.size_chart).toEqual({
      name: 'Abaya',
      unit: 'cm',
      columns: [
        { label: 'Size', label_ar: 'المقاس' },
        { label: 'Length', label_ar: 'الطول' },
      ],
      rows: [['S', '52']],
    });
  });

  it('omits every key when the merchant entered nothing (or switched personalisation off)', async () => {
    const out = await call({
      facts: [],
      personalisation: { enabled: false, required: true, label: 'x', labelAr: '', maxLength: 5 },
      leadTimeDays: null,
      sizeChart: null,
    });
    for (const k of ['facts', 'personalisation', 'lead_time_days', 'size_chart']) {
      expect(out).not.toHaveProperty(k);
    }
  });
});
