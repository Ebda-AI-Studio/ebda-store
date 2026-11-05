import { describe, expect, it } from 'vitest';
import { childToParentSchema, BUILDER_PROTOCOL } from '@ebda/shared';
import { chipTopFor } from '../../apps/web/src/builder/preview/EditorOverlay';
import { initialViewport } from '../../apps/admin/src/app/stores/[id]/builder/_components/BuilderEditor';

describe('name chip (bug 1)', () => {
  it('sits above the box when there is room, below it at the page top, never over it', () => {
    expect(chipTopFor({ top: 100, height: 300 })).toBe(76);
    expect(chipTopFor({ top: 0, height: 64 })).toBe(68);
    expect(chipTopFor({ top: 23, height: 50 })).toBe(77);
  });
});

describe('open-admin message', () => {
  const ok = { protocol: BUILDER_PROTOCOL, type: 'open-admin', target: 'products' };
  it('accepts only the closed list of admin pages', () => {
    expect(childToParentSchema.safeParse(ok).success).toBe(true);
    expect(childToParentSchema.safeParse({ ...ok, target: 'categories' }).success).toBe(true);
    expect(childToParentSchema.safeParse({ ...ok, target: 'https://evil.example' }).success).toBe(
      false
    );
    expect(childToParentSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });
});

describe('device the editor opens on (E-4)', () => {
  it('remembered choice wins, else the window decides', () => {
    expect(initialViewport('tablet', 1440)).toBe('tablet');
    expect(initialViewport(null, 1440)).toBe('desktop');
    expect(initialViewport(null, 900)).toBe('tablet');
    expect(initialViewport(null, 390)).toBe('mobile');
    expect(initialViewport('bogus', 1440)).toBe('desktop');
  });
});
