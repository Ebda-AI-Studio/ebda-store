/**
 * Ruling D1016-ICONS-1 (Ahmad 2026-10-16, "cloudflare images"): with the Workers Images binding
 * (`env.IMAGES`, Whisky account) the PWA icon set is RESIZED, not the source stored under every
 * key (supersedes FU46-8's pass-through for icons): each target is a PNG of its own size, and the
 * maskable icon is the Android adaptive shape — the art scaled into the central 80% (410px) and
 * padded to 512 with the store's opaque PWA background. Without the binding, or when a call fails
 * or returns the wrong size, the whole set falls back to today's behaviour (the source as-is).
 *
 * The deploy only carries the binding when the repo variable `EBDA_IMAGES_BINDING=true`
 * (scripts/ebda-cf-api-config.mjs), and the workerd smoke strips it like the AI binding.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fakePng } from '../helpers/png-fixtures';

const uploadMock = vi.fn(
  async (buffer: Buffer, name: string, o: { storeId?: string; filename?: string }) => ({
    key: `stores/${o.storeId}/pwa/${o.filename ?? name}`,
    url: `https://cdn.example.r2.dev/stores/${o.storeId}/pwa/${o.filename ?? name}`,
    size: buffer.length,
    contentType: 'image/png',
  })
);
const warn = vi.fn();
vi.mock('@api/services/storage.service', () => ({ StorageService: { upload: uploadMock } }));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn, info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@ebda/database', () => ({ prisma: {}, Prisma: {} }));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: vi.fn().mockResolvedValue(true) },
}));
vi.mock('@api/lib/revalidate-storefront', () => ({ revalidateStorefront: vi.fn() }));
const { incrementFixedWindow, sendAlert } = vi.hoisted(() => ({
  incrementFixedWindow: vi.fn(async () => 1),
  sendAlert: vi.fn(async () => 'sent'),
}));
vi.mock('@api/services/redis.service', () => ({ redis: { incrementFixedWindow } }));
vi.mock('@api/services/alerts.service', () => ({ sendAlert }));

const { setCfBindings, clearCfBindings } = await import('@api/cf/bindings');
const { generatePwaIconSet } = await import('@api/services/pwa.service');
const { pngDimensions } = await import('@api/lib/upload-sniff');

const STORE_ID = '11111111-1111-1111-1111-111111111111';
const SIZES: Record<string, number> = {
  icon192: 192,
  icon384: 384,
  icon512: 512,
  iconAppleTouch: 180,
  favicon32: 32,
  favicon16: 16,
  maskableIcon: 512,
};

type Op = Record<string, unknown> & { width?: number; border?: { width?: number; color?: string } };
/** A fake `env.IMAGES`: records each chain and answers a PNG of the size the chain asks for. */
function fakeImages(mode: 'ok' | 'throw' | 'wrong-size' | 'hang' = 'ok') {
  const chains: Array<{ ops: Op[]; output: Record<string, unknown> }> = [];
  const binding = {
    input(_stream: ReadableStream) {
      const ops: Op[] = [];
      const handle = {
        transform(o: Op) {
          ops.push(o);
          return handle;
        },
        async output(output: Record<string, unknown>) {
          chains.push({ ops, output });
          if (mode === 'throw') throw new Error('IMAGES_TRANSFORM_ERROR 9432: not enabled');
          if (mode === 'hang') await new Promise(() => {});
          const last = ops[ops.length - 1];
          const side = (last.width ?? 0) + 2 * (last.border?.width ?? 0);
          const px = mode === 'wrong-size' ? side + 1 : side;
          return { response: () => new Response(new Uint8Array(fakePng(px, px))) };
        },
      };
      return handle;
    },
  };
  return { chains, binding };
}

const uploaded = (key: string) =>
  uploadMock.mock.calls.find(c => c[1] === `${key}.png`)![0] as Buffer;

beforeEach(() => {
  uploadMock.mockClear();
  warn.mockClear();
  incrementFixedWindow.mockClear();
  incrementFixedWindow.mockResolvedValue(1);
  sendAlert.mockClear();
});
afterEach(() => clearCfBindings());

describe('PWA icons through Cloudflare Images (D1016-ICONS-1)', () => {
  it('each target is a PNG of its own size; the source is stored unchanged', async () => {
    const { binding, chains } = fakeImages();
    setCfBindings({ HYPERDRIVE: { connectionString: '' }, IMAGES: binding });
    const source = fakePng(1024, 1024);
    await generatePwaIconSet(STORE_ID, source, { background: '#0A0B0C' });
    for (const [key, size] of Object.entries(SIZES))
      expect(pngDimensions(uploaded(key)), key).toEqual({ width: size, height: size });
    expect(uploaded('source').equals(source)).toBe(true);
    for (const c of chains) expect(c.output.format).toBe('image/png');
  });

  it('the maskable icon is padded: art in the central 80%, opaque store background', async () => {
    const { binding, chains } = fakeImages();
    setCfBindings({ HYPERDRIVE: { connectionString: '' }, IMAGES: binding });
    await generatePwaIconSet(STORE_ID, fakePng(600, 600), { background: '#0A0B0C' });
    const padded = chains.filter(c => c.ops.some(o => o.border));
    expect(padded).toHaveLength(1);
    const op = padded[0].ops[padded[0].ops.length - 1];
    expect(op.width).toBe(410);
    expect(op.border).toEqual({ color: '#0A0B0C', width: 51 });
    expect(op.background).toBe('#0A0B0C');
  });

  it('a non-hex background falls back to white (the value reaches an image request)', async () => {
    const { binding, chains } = fakeImages();
    setCfBindings({ HYPERDRIVE: { connectionString: '' }, IMAGES: binding });
    await generatePwaIconSet(STORE_ID, fakePng(600, 600), { background: 'red;x' });
    const op = chains.find(c => c.ops.some(o => o.border))!.ops.at(-1)!;
    expect(op.border?.color).toBe('#FFFFFF');
  });

  it.each(['throw', 'wrong-size'] as const)(
    'a %s answer falls back to the source for the WHOLE set, with one warning',
    async mode => {
      const { binding } = fakeImages(mode);
      setCfBindings({ HYPERDRIVE: { connectionString: '' }, IMAGES: binding });
      const source = fakePng(600, 600);
      await generatePwaIconSet(STORE_ID, source, { background: '#ffffff' });
      for (const key of Object.keys(SIZES)) expect(uploaded(key).equals(source), key).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
    }
  );

  it('a hung binding is cut off by the deadline and the whole set falls back (review M1)', async () => {
    const { binding } = fakeImages('hang');
    setCfBindings({ HYPERDRIVE: { connectionString: '' }, IMAGES: binding });
    const source = fakePng(600, 600);
    await generatePwaIconSet(STORE_ID, source, { background: '#ffffff', deadlineMs: 50 });
    for (const key of Object.keys(SIZES)) expect(uploaded(key).equals(source), key).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0].err)).toMatch(/deadline/i);
  });

  it('a fallback logs a stable code, counts it per day, and alerts once a day (review N3)', async () => {
    const { binding } = fakeImages('throw');
    setCfBindings({ HYPERDRIVE: { connectionString: '' }, IMAGES: binding });
    await generatePwaIconSet(STORE_ID, fakePng(600, 600), { background: '#ffffff' });
    expect(warn.mock.calls[0][0]).toMatchObject({
      code: 'PWA_ICON_RESIZE_FALLBACK',
      storeId: STORE_ID,
    });
    expect(incrementFixedWindow).toHaveBeenCalledWith(
      expect.stringMatching(/^metric:pwa-icon-resize-fallback:\d{4}-\d{2}-\d{2}$/),
      2 * 24 * 60 * 60
    );
    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(sendAlert.mock.calls[0][0]).toMatchObject({
      level: 'p1',
      scope: 'platform',
      source: 'pwa.icon-resize-fallback',
    });
    // the second fallback of the day is counted, not re-alerted
    incrementFixedWindow.mockResolvedValue(2);
    await generatePwaIconSet(STORE_ID, fakePng(600, 600), { background: '#ffffff' });
    expect(incrementFixedWindow).toHaveBeenCalledTimes(2);
    expect(sendAlert).toHaveBeenCalledTimes(1);
  });

  it('no binding at all is not a fallback event (nothing counted, nothing alerted)', async () => {
    await generatePwaIconSet(STORE_ID, fakePng(600, 600));
    expect(incrementFixedWindow).not.toHaveBeenCalled();
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('no binding: today’s behaviour, the source under every key', async () => {
    const source = fakePng(600, 600);
    await generatePwaIconSet(STORE_ID, source);
    for (const key of Object.keys(SIZES)) expect(uploaded(key).equals(source), key).toBe(true);
  });
});

describe('the binding is behind a deploy switch', () => {
  it('the deploy config adds `images` only when EBDA_IMAGES_BINDING=true', async () => {
    const { withImagesBinding } = await import('../../scripts/ebda-cf-api-config.mjs');
    const src = readFileSync('apps/api/wrangler.jsonc', 'utf8');
    expect(src).not.toMatch(/"images":/);
    expect(withImagesBinding(src, 'true')).toMatch(/"images":\s*\{\s*"binding":\s*"IMAGES"\s*\}/);
    expect(withImagesBinding(src, undefined)).toBe(src);
    expect(withImagesBinding(src, 'false')).toBe(src);
  });
  it('every wrangler env section gets the binding too (review M3)', async () => {
    const { withImagesBinding } = await import('../../scripts/ebda-cf-api-config.mjs');
    const src =
      '{\n  "ai": { "binding": "AI" },\n  "env": {\n    "staging": {\n      "ai": { "binding": "AI" },\n    },\n  },\n}\n';
    const out = withImagesBinding(src, 'true');
    expect(out.match(/"images": \{ "binding": "IMAGES" \}/g)?.length).toBe(2);
    expect(out).toMatch(/\n      "images": \{ "binding": "IMAGES" \},\n/); // keeps the env indent
  });

  it('the workerd smoke strips it, like the AI binding', async () => {
    const { stripImagesBinding } = await import('../../scripts/ci/workerd-smoke.mjs');
    const { withImagesBinding } = await import('../../scripts/ebda-cf-api-config.mjs');
    const src = readFileSync('apps/api/wrangler.jsonc', 'utf8');
    expect(stripImagesBinding(withImagesBinding(src, 'true'))).toBe(src);
    expect(stripImagesBinding(src)).toBe(src);
  });
  it('the deploy workflow passes the repo variable', () => {
    const wf = readFileSync('.github/workflows/cf-api-deploy.yml', 'utf8');
    expect(wf).toMatch(/EBDA_IMAGES_BINDING: \$\{\{ vars\.EBDA_IMAGES_BINDING \}\}/);
  });
});

describe('PWA icons with an injected resizer (the Node backfill script, no Images binding)', () => {
  it('uses the resizer for every target, never the fallback, and raises no resize alert', async () => {
    const resizer = vi.fn(async (_src: Buffer, t: { size: number }) => fakePng(t.size, t.size));
    const source = fakePng(1024, 1024);
    await generatePwaIconSet(STORE_ID, source, { background: '#0A0B0C', resizer });
    expect(resizer).toHaveBeenCalledTimes(7);
    expect(resizer.mock.calls.filter(c => (c[1] as { padded: boolean }).padded)).toHaveLength(1);
    for (const [key, size] of Object.entries(SIZES))
      expect(pngDimensions(uploaded(key)), key).toEqual({ width: size, height: size });
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('a resizer answering the wrong size is refused, nothing is uploaded', async () => {
    const resizer = async (_s: Buffer, t: { size: number }) => fakePng(t.size + 1, t.size + 1);
    await expect(
      generatePwaIconSet(STORE_ID, fakePng(1024, 1024), { resizer })
    ).rejects.toMatchObject({ code: 'ICON_GENERATION_FAILED' });
    expect(uploadMock).not.toHaveBeenCalled();
  });
});
