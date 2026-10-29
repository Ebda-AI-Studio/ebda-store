// #1917 — the script called PWAService.updateSettings() and moved on
// regardless of what it returned, so a write that silently failed to persist
// (a stale connection, a swallowed error inside a transaction, etc.) was
// reported as a success. iconWriteLanded() is the check that now gates it,
// compared against the UPDATE ... RETURNING row updateSettings() itself
// returns — not a second query.
import { describe, it, expect } from 'vitest';
import { iconWriteLanded } from '../../scripts/backfill-store-pwa-icons';

describe('iconWriteLanded — confirms the write actually persisted', () => {
  it('is true when the returned row matches what was generated', () => {
    expect(
      iconWriteLanded(
        { iconAppleTouch: 'https://r2.example/store/apple-touch.png' },
        { iconAppleTouch: 'https://r2.example/store/apple-touch.png' }
      )
    ).toBe(true);
  });

  it('is false when the returned row still has no iconAppleTouch (write did not land)', () => {
    expect(
      iconWriteLanded({ iconAppleTouch: undefined }, { iconAppleTouch: 'https://r2.example/x.png' })
    ).toBe(false);
  });

  it('is false when the returned row disagrees with what was generated', () => {
    expect(
      iconWriteLanded(
        { iconAppleTouch: 'https://r2.example/stale.png' },
        { iconAppleTouch: 'https://r2.example/new.png' }
      )
    ).toBe(false);
  });
});

// F7: the backfill is idempotent, resumable and dry-run by default, and skips stores with no logo.
import { vi } from 'vitest';
import sharp from 'sharp';
import {
  REQUIRED_ICON_KEYS,
  iconSetComplete,
  pickIconSource,
  normalizeSource,
  backfillStore,
  parseArgs,
  safeSourceUrl,
  type BackfillDeps,
} from '../../scripts/backfill-store-pwa-icons';

const png = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 4, background: '#B08D57' } })
    .png()
    .toBuffer();

const FULL = Object.fromEntries(REQUIRED_ICON_KEYS.map(k => [k, `https://cdn.example/${k}.png`]));
const ICONS = Object.fromEntries(
  REQUIRED_ICON_KEYS.map(k => [k, `https://cdn.example/new-${k}.png`])
);

function deps(over: Partial<BackfillDeps> = {}): BackfillDeps {
  return {
    fetchSource: vi.fn(async () => png(600, 600)),
    generate: vi.fn(async () => ICONS as never),
    readSettings: vi.fn(async () => ({})),
    write: vi.fn(async () => ICONS as never),
    ...over,
  };
}
const store = (over: Record<string, unknown> = {}) => ({
  id: 's-1',
  slug: 'abc',
  logo: 'https://cdn.example/logo.png',
  pwaSettings: {},
  ...over,
});

describe('iconSetComplete / pickIconSource', () => {
  it('complete only when every required key is set', () => {
    expect(iconSetComplete(FULL)).toBe(true);
    expect(iconSetComplete({ ...FULL, favicon16: undefined })).toBe(false);
    expect(iconSetComplete({})).toBe(false);
  });
  it('prefers the merchant source, then the 512, 192, then the logo; null when none', () => {
    expect(pickIconSource({ iconSource: 'a', icon512: 'b' }, 'l')).toBe('a');
    expect(pickIconSource({ icon512: 'b', icon192: 'c' }, 'l')).toBe('b');
    expect(pickIconSource({}, 'l')).toBe('l');
    expect(pickIconSource({}, null)).toBeNull();
    expect(pickIconSource({}, '  ')).toBeNull();
  });
});

describe('safeSourceUrl', () => {
  it('only public https hosts', () => {
    expect(safeSourceUrl('https://cdn.example/x.png')).toBe(true);
    for (const bad of [
      'http://cdn.example/x.png',
      'https://localhost/x',
      'https://127.0.0.1/x',
      'https://10.0.0.5/x',
      'file:///etc/passwd',
      'not a url',
    ])
      expect(safeSourceUrl(bad), bad).toBe(false);
  });
});

describe('normalizeSource', () => {
  it('keeps a square PNG >= 512 as is', async () => {
    const src = await png(600, 600);
    const r = await normalizeSource(src);
    expect('png' in r && r.png.equals(src)).toBe(true);
  });
  it('pads a wide logo onto a square PNG of at least 512', async () => {
    const r = await normalizeSource(await png(800, 400));
    expect('png' in r).toBe(true);
    if ('png' in r) {
      const m = await sharp(r.png).metadata();
      expect(m.width).toBe(m.height);
      expect(m.width).toBeGreaterThanOrEqual(512);
    }
  });
  it('skips a logo too small to scale up and bytes that are not an image', async () => {
    expect(await normalizeSource(await png(100, 100))).toEqual({ skip: 'source_too_small' });
    expect(await normalizeSource(Buffer.from('<html>'))).toEqual({ skip: 'source_unreadable' });
  });
});

describe('backfillStore', () => {
  it('skips a store whose set is complete, touching nothing', async () => {
    const d = deps();
    expect(await backfillStore(store({ pwaSettings: FULL }), true, d)).toMatchObject({
      status: 'skipped',
      reason: 'complete',
    });
    expect(d.fetchSource).not.toHaveBeenCalled();
  });

  it('skips a store with no logo and no icon (no fetch)', async () => {
    const d = deps();
    expect(await backfillStore(store({ logo: null }), true, d)).toMatchObject({
      status: 'skipped',
      reason: 'no_logo',
    });
    expect(d.fetchSource).not.toHaveBeenCalled();
  });

  it('dry run fetches and validates but never uploads or writes', async () => {
    const d = deps();
    expect(await backfillStore(store(), false, d)).toMatchObject({ status: 'would_generate' });
    expect(d.generate).not.toHaveBeenCalled();
    expect(d.write).not.toHaveBeenCalled();
  });

  it('dry run reports a skip reason for an unusable logo', async () => {
    const d = deps({ fetchSource: vi.fn(async () => png(100, 100)) });
    expect(await backfillStore(store(), false, d)).toMatchObject({
      status: 'skipped',
      reason: 'source_too_small',
    });
  });

  it('apply generates, writes and confirms the write landed', async () => {
    const d = deps();
    expect(await backfillStore(store(), true, d)).toMatchObject({ status: 'generated' });
    expect(d.write).toHaveBeenCalledWith('s-1', ICONS);
  });

  it('apply never overwrites a set the merchant completed while we were generating', async () => {
    const d = deps({ readSettings: vi.fn(async () => FULL) });
    expect(await backfillStore(store(), true, d)).toMatchObject({
      status: 'skipped',
      reason: 'raced',
    });
    expect(d.write).not.toHaveBeenCalled();
  });

  it('a fetch failure or a write that did not land is failed, not generated', async () => {
    const bad = deps({ fetchSource: vi.fn(async () => Promise.reject(new Error('HTTP 404'))) });
    expect(await backfillStore(store(), true, bad)).toMatchObject({ status: 'failed' });
    const lost = deps({ write: vi.fn(async () => ({ iconAppleTouch: 'stale' }) as never) });
    expect(await backfillStore(store(), true, lost)).toMatchObject({ status: 'failed' });
  });

  it('an unsafe source url is skipped before any fetch', async () => {
    const d = deps();
    expect(await backfillStore(store({ logo: 'http://169.254.169.254/x' }), true, d)).toMatchObject(
      {
        status: 'skipped',
        reason: 'unsafe_source_url',
      }
    );
    expect(d.fetchSource).not.toHaveBeenCalled();
  });
});

describe('parseArgs', () => {
  it('is a dry run unless --apply is passed', () => {
    expect(parseArgs([]).apply).toBe(false);
    expect(parseArgs(['--apply']).apply).toBe(true);
  });
  it('reads --store, --after and a bounded --limit', () => {
    expect(parseArgs(['--store', 'x', '--after', 'abc', '--limit', '5'])).toMatchObject({
      store: 'x',
      after: 'abc',
      limit: 5,
    });
    expect(parseArgs(['--limit', '0']).limit).toBeUndefined();
    expect(parseArgs([]).limit).toBeUndefined();
  });
});

describe('sharpResizer', () => {
  it('renders each size exactly; the maskable icon is opaque with the store colour in the corner', async () => {
    const { sharpResizer } = await import('../../scripts/backfill-store-pwa-icons');
    const src = await png(600, 600);
    for (const size of [192, 180, 32, 16]) {
      const out = await sharpResizer(src, { size, padded: false }, undefined);
      expect(await sharp(out).metadata()).toMatchObject({ width: size, height: size });
    }
    const mask = await sharpResizer(src, { size: 512, padded: true }, '#102030');
    const { data, info } = await sharp(mask).raw().toBuffer({ resolveWithObject: true });
    expect(info).toMatchObject({ width: 512, height: 512 });
    const px = (x: number, y: number) =>
      Array.from(data.subarray((y * 512 + x) * info.channels, (y * 512 + x) * info.channels + 3));
    expect(px(2, 2)).toEqual([0x10, 0x20, 0x30]);
    expect(px(256, 256)).toEqual([0xb0, 0x8d, 0x57]);
    expect(info.channels === 3 || data[3] === 255).toBe(true);
  });
});
