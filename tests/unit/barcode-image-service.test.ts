import { describe, it, expect, vi, beforeEach } from 'vitest';

const put = vi.fn();
const avail = vi.fn();
vi.mock('@api/services/storage.service', () => ({
  StorageService: {
    isAvailable: () => avail(),
    putDerived: (...a: unknown[]) => put(...a),
    getPublicUrl: (k: string) => `https://cdn.ebda.app/${k}`,
  },
}));
const cfg = vi.hoisted(() => ({
  jwtSecret: 'x'.repeat(40),
  barcodeKeySecret: '',
  encryptionKey: 'e'.repeat(64),
}));
vi.mock('@api/config', () => ({ config: cfg }));
vi.mock('@api/lib/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { ensureEmailBarcode } = await import('@api/services/barcode-image.service');
const STORE = '3f2a91c4-7b1e-4d0a-9c55-0e8a1f2b3c4d';

beforeEach(() => {
  put.mockReset().mockResolvedValue(undefined);
  avail.mockReset().mockReturnValue(true);
});

describe('ensureEmailBarcode', () => {
  it('renders, stores under a store-scoped keyed name and returns the https url + displayed size', async () => {
    const r = await ensureEmailBarcode({
      storeId: STORE,
      kind: 'order',
      number: 'ORD-T5JK9Q-AB3XY',
      shape: 'palm',
    });
    expect(r).not.toBeNull();
    expect(r!.url).toMatch(
      new RegExp(`^https://cdn\\.ebda\\.app/stores/${STORE}/barcodes/[0-9a-f]{32}\\.png$`)
    );
    expect(r!.width).toBe(360);
    expect(r!.height).toBeGreaterThan(100);
    const [key, body, contentType] = put.mock.calls[0]!;
    expect(key).toContain(`stores/${STORE}/barcodes/`);
    expect(Array.from((body as Uint8Array).slice(0, 4))).toEqual([137, 80, 78, 71]);
    expect(contentType).toBe('image/png');
    expect(r!.url).not.toContain('T5JK9Q');
  });
  it('off draws nothing', async () => {
    expect(
      await ensureEmailBarcode({
        storeId: STORE,
        kind: 'order',
        number: 'ORD-T5JK9Q-AB3XY',
        shape: 'off',
      })
    ).toBeNull();
    expect(put).not.toHaveBeenCalled();
  });
  it('NEVER throws or blocks: storage down, upload failure, bad store id, unencodable number all give null', async () => {
    avail.mockReturnValue(false);
    expect(
      await ensureEmailBarcode({ storeId: STORE, kind: 'order', number: 'ORD-1', shape: 'plain' })
    ).toBeNull();
    avail.mockReturnValue(true);
    put.mockRejectedValue(new Error('r2 down'));
    expect(
      await ensureEmailBarcode({ storeId: STORE, kind: 'order', number: 'ORD-1', shape: 'plain' })
    ).toBeNull();
    put.mockResolvedValue(undefined);
    expect(
      await ensureEmailBarcode({
        storeId: 'not-a-uuid',
        kind: 'order',
        number: 'ORD-1',
        shape: 'plain',
      })
    ).toBeNull();
    expect(
      await ensureEmailBarcode({ storeId: STORE, kind: 'order', number: 'طلب-١', shape: 'plain' })
    ).toBeNull();
  });
  it('gives up after the time budget instead of holding the email', async () => {
    put.mockImplementation(() => new Promise(() => {}));
    const t = Date.now();
    expect(
      await ensureEmailBarcode({
        storeId: STORE,
        kind: 'order',
        number: 'ORD-1',
        shape: 'plain',
        timeoutMs: 50,
      })
    ).toBeNull();
    expect(Date.now() - t).toBeLessThan(1000);
  });
  it('refuses a non-https public url (emails need absolute https)', async () => {
    vi.resetModules();
    vi.doMock('@api/services/storage.service', () => ({
      StorageService: {
        isAvailable: () => true,
        putDerived: put,
        getPublicUrl: (k: string) => `/relative/${k}`,
      },
    }));
    const { ensureEmailBarcode: e2 } = await import('@api/services/barcode-image.service');
    expect(await e2({ storeId: STORE, kind: 'order', number: 'ORD-1', shape: 'plain' })).toBeNull();
  });
});

describe('plain PNG holds the 2 css px module floor (I2)', () => {
  it('a legacy 24-char number (too many modules for 360 css px) sends text only', async () => {
    const r = await ensureEmailBarcode({
      storeId: STORE,
      kind: 'order',
      number: 'ORD-1760000000000-ab12cd34',
      shape: 'plain',
    });
    expect(r).toBeNull();
    expect(put).not.toHaveBeenCalled();
  });
  it('a standard number is fine', async () => {
    expect(
      await ensureEmailBarcode({
        storeId: STORE,
        kind: 'order',
        number: 'ORD-T5JK9Q-AB3XY',
        shape: 'plain',
      })
    ).not.toBeNull();
  });
});

describe('timer and key secret', () => {
  it('clears the time-budget timer when the work finishes (M1)', async () => {
    const spy = vi.spyOn(globalThis, 'clearTimeout');
    await ensureEmailBarcode({
      storeId: STORE,
      kind: 'order',
      number: 'ORD-T5JK9Q-AB3XY',
      shape: 'plain',
    });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
  it('keys come from BARCODE_KEY_SECRET, not the JWT secret: rotating JWT changes nothing (M2)', async () => {
    cfg.barcodeKeySecret = 'k'.repeat(40);
    const key = async () => {
      put.mockClear();
      await ensureEmailBarcode({
        storeId: STORE,
        kind: 'order',
        number: 'ORD-T5JK9Q-AB3XY',
        shape: 'plain',
      });
      return put.mock.calls[0]![0] as string;
    };
    const a = await key();
    cfg.jwtSecret = 'rotated-'.padEnd(40, 'z');
    expect(await key()).toBe(a);
    cfg.barcodeKeySecret = 'other-'.padEnd(40, 'q');
    expect(await key()).not.toBe(a);
  });
  it('unset: derived from ENCRYPTION_KEY, also untouched by a JWT rotation', async () => {
    cfg.barcodeKeySecret = '';
    const key = async () => {
      put.mockClear();
      await ensureEmailBarcode({
        storeId: STORE,
        kind: 'order',
        number: 'ORD-T5JK9Q-AB3XY',
        shape: 'plain',
      });
      return put.mock.calls[0]![0] as string;
    };
    const a = await key();
    cfg.jwtSecret = 'rotated-again-'.padEnd(40, 'z');
    expect(await key()).toBe(a);
    cfg.encryptionKey = 'f'.repeat(64);
    expect(await key()).not.toBe(a);
  });
  it('no secret at all (non-production only): text-only email, never a throw', async () => {
    cfg.barcodeKeySecret = '';
    cfg.encryptionKey = '';
    expect(
      await ensureEmailBarcode({
        storeId: STORE,
        kind: 'order',
        number: 'ORD-T5JK9Q-AB3XY',
        shape: 'plain',
      })
    ).toBeNull();
  });
});
