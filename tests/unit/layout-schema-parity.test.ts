/**
 * Guard test — layout PUT schema parity with StoreLayoutSettings
 *
 * THE BUG CLASS (recurred ~4 times: productsPage, cartPage, locationsPage,
 * bottomBar): `layoutSchema` in store-layout.routes.ts is a strict
 * `z.object({...}).partial()` with NO `.passthrough()`. Any top-level key in
 * `StoreLayoutSettings` that isn't explicitly listed in the Zod shape is
 * silently stripped on every PUT. The admin save "succeeds" (HTTP 200) but
 * the merchant's change is quietly lost — "page builder doesn't save my
 * changes."
 *
 * This test fails when ANY key in `LAYOUT_TOP_LEVEL_KEYS` (the compile-time-
 * guarded runtime mirror of `StoreLayoutSettings`) is missing from the API
 * schema. It will catch the next new layout key before it ships broken.
 *
 * How we enumerate the schema's keys:
 *   `layoutSchema` is `z.ZodObject.partial()` which returns a `ZodObject`
 *   whose `.shape` property is the plain object of field schemas. The `.shape`
 *   accessor is available on `ZodObject` directly — no ._def traversal needed.
 */

import { describe, it, expect } from 'vitest';

// The runtime key list with compile-time assertions that it stays in sync
// with the StoreLayoutSettings interface.
import { LAYOUT_TOP_LEVEL_KEYS } from '@force/shared';

// The exported Zod schema from the route file. We import it here so the test
// can introspect its shape without spinning up the Express app.
// Note: the route file imports prisma + redis; vitest will resolve them via
// the workspace aliases so no mocking is needed for this pure shape check.
import { layoutSchema } from '../../apps/api/src/routes/store-layout.routes';

describe('layout PUT schema parity — StoreLayoutSettings vs layoutSchema', () => {
  it('every key in LAYOUT_TOP_LEVEL_KEYS is present in the API layoutSchema', () => {
    // layoutSchema is ZodObject.partial() → .shape enumerates accepted keys.
    const schemaKeys = new Set(Object.keys(layoutSchema.shape));

    const missingKeys = (LAYOUT_TOP_LEVEL_KEYS as readonly string[]).filter(
      key => !schemaKeys.has(key)
    );

    expect(
      missingKeys,
      [
        '',
        'LAYOUT SCHEMA PARITY FAILURE',
        '─────────────────────────────────────────────────────────',
        'The following StoreLayoutSettings keys are NOT listed in the',
        'layoutSchema (packages/shared/src/builder/layout-schema.ts, re-exported by store-layout.routes.ts):',
        '',
        missingKeys.map(k => `  • "${k}"`).join('\n'),
        '',
        'Because layoutSchema uses z.object({...}).partial() with NO',
        '.passthrough(), any unlisted key is SILENTLY STRIPPED on every',
        'PUT /admin/stores/:id/layout. The admin save returns HTTP 200',
        "but the merchant's change is quietly lost.",
        '',
        'Fix: add the missing key(s) to the layout schema in packages/shared/src/builder/layout-schema.ts.',
        '─────────────────────────────────────────────────────────',
      ].join('\n')
    ).toEqual([]);
  });

  it('layoutSchema has a .shape property (confirming it is a ZodObject)', () => {
    // Sanity check: if the schema structure changes (e.g. wrapped in z.lazy)
    // and .shape stops being accessible, this catches it early with a clear
    // error rather than silently passing because Object.keys(undefined) = [].
    expect(layoutSchema.shape).toBeDefined();
    expect(typeof layoutSchema.shape).toBe('object');
    expect(Object.keys(layoutSchema.shape).length).toBeGreaterThan(0);
  });
});
