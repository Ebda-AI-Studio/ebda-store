/**
 * POST /stores (createStoreSchema) runs the SAME `settings` link checks as the update route:
 * `contact.addressUrl` and every `floatingWidget` button link render into `<a href>`, so a
 * check on update only would leave store creation as the stored-XSS bypass.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@ebda/database', () => ({
  prisma: {},
  Prisma: {},
  withMoneyTx: vi.fn(),
  withStore: vi.fn(),
  acrossStores: vi.fn(),
}));
vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: { delete: vi.fn(), get: vi.fn(), set: vi.fn(), getClient: vi.fn(() => null) },
}));
vi.mock('../../apps/api/src/lib/public-cache', () => ({
  invalidateCached: vi.fn(),
  invalidateCachedPrefix: vi.fn(),
  memoryCache: { get: vi.fn(), set: vi.fn() },
}));
vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock('../../apps/api/src/services/r2-cleanup.service', () => ({
  cleanupRemovedImages: vi.fn(),
  deleteR2ObjectIfOrphan: vi.fn(),
}));
vi.mock('../../apps/api/src/services/accounting/account.service', () => ({
  seedCoaForStore: vi.fn(),
}));

import { createStoreSchema, updateStoreSchema } from '../../apps/api/src/routes/store.routes';

const widget = (customHref: string) => ({
  floatingWidget: { buttons: [{ id: 'a', kind: 'custom', customHref }] },
});

describe.each([
  ['create (POST /stores)', createStoreSchema],
  ['update (PUT /stores/:id)', updateStoreSchema],
] as const)('%s settings link checks', (_label, schema) => {
  it('rejects a javascript: contact.addressUrl', () => {
    const r = schema.safeParse({
      name: 'S',
      settings: { contact: { addressUrl: 'javascript:alert(1)' } },
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].path).toEqual(['settings', 'contact', 'addressUrl']);
  });

  it('rejects a javascript: floating-widget link', () => {
    const r = schema.safeParse({ name: 'S', settings: widget('javascript:alert(1)') });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].path).toEqual([
      'settings',
      'floatingWidget',
      'buttons',
      0,
      'customHref',
    ]);
  });

  it('accepts safe links', () => {
    const r = schema.safeParse({
      name: 'S',
      settings: {
        contact: { addressUrl: 'https://maps.example.com/x' },
        ...widget('tel:+201000000000'),
      },
    });
    expect(r.success).toBe(true);
  });
});
