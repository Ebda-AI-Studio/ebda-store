/**
 * Meta provisioner env vars were renamed FORCE_AI_META_* -> EBDA_META_*.
 * The new name wins; the old name is a one-release fallback (TODO 2026-12-01).
 */
import { describe, it, expect } from 'vitest';
import { resolveMetaEnv } from '../../apps/api/src/services/meta-provisioner.service';

const OLD = (k: string) => ['FORCE', 'AI', 'META', k].join('_');

describe('meta provisioner env resolution', () => {
  it('reads the new names', () => {
    const r = resolveMetaEnv({
      EBDA_META_BM_ID: 'bm-new',
      EBDA_META_ADMIN_TOKEN: 'tok-new',
      EBDA_META_PROVISIONER_USER_ID: 'u-new',
    });
    expect(r).toEqual({ bmId: 'bm-new', adminToken: 'tok-new', provisionerUserId: 'u-new' });
  });

  it('falls back to the old names when the new ones are unset', () => {
    const r = resolveMetaEnv({
      [OLD('BM_ID')]: 'bm-old',
      [OLD('ADMIN_TOKEN')]: 'tok-old',
      [OLD('PROVISIONER_USER_ID')]: 'u-old',
    });
    expect(r).toEqual({ bmId: 'bm-old', adminToken: 'tok-old', provisionerUserId: 'u-old' });
  });

  it('prefers the new name over the old one, per variable', () => {
    const r = resolveMetaEnv({
      EBDA_META_BM_ID: 'bm-new',
      [OLD('BM_ID')]: 'bm-old',
      [OLD('ADMIN_TOKEN')]: 'tok-old',
    });
    expect(r.bmId).toBe('bm-new');
    expect(r.adminToken).toBe('tok-old');
  });

  it('treats blank values as unset', () => {
    const r = resolveMetaEnv({ EBDA_META_BM_ID: '', [OLD('BM_ID')]: 'bm-old' });
    expect(r.bmId).toBe('bm-old');
    expect(resolveMetaEnv({}).bmId).toBeUndefined();
  });
});
