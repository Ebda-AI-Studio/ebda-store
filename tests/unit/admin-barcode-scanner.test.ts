/**
 * iOS has no native BarcodeDetector (Safari + home-screen PWA), so Stock -> Scan showed "not supported" to every iPhone
 * merchant. The shared engine (apps/admin/src/lib/barcode-scanner.ts) must use native when it covers our formats, the
 * self-hosted WASM ponyfill otherwise, and the admin CSP must let that WASM run and load from 'self'.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildAdminCsp } from '../../apps/admin/src/lib/csp';

const ADMIN = join(__dirname, '../../apps/admin');
const ALL = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'];

const overrides = vi.fn();
class Ponyfill {
  tag = 'wasm';
  detect = async () => [];
}
vi.mock('barcode-detector/ponyfill', () => ({
  BarcodeDetector: Ponyfill,
  setZXingModuleOverrides: (o: unknown) => overrides(o),
}));

async function load() {
  vi.resetModules();
  return import('../../apps/admin/src/lib/barcode-scanner');
}

afterEach(() => {
  delete (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector;
  overrides.mockClear();
});

describe('createScanDetector', () => {
  it('uses the native detector when present and it covers every format we need', async () => {
    class Native {
      tag = 'native';
      static getSupportedFormats = async () => ALL;
      detect = async () => [];
    }
    (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector = Native;
    const { createScanDetector } = await load();
    const r = await createScanDetector();
    expect(r.engine).toBe('native');
    expect((r.detector as unknown as Native).tag).toBe('native');
    expect(overrides).not.toHaveBeenCalled();
  });

  it('uses the WASM ponyfill when window.BarcodeDetector is absent (iOS)', async () => {
    const { createScanDetector } = await load();
    const r = await createScanDetector();
    expect(r.engine).toBe('wasm');
    expect((r.detector as unknown as Ponyfill).tag).toBe('wasm');
  });

  it('uses the ponyfill when native lacks a needed format (e.g. no ean_13)', async () => {
    class Partial {
      static getSupportedFormats = async () => ['qr_code'];
      detect = async () => [];
    }
    (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector = Partial;
    const { createScanDetector } = await load();
    expect((await createScanDetector()).engine).toBe('wasm');
  });

  it('points the WASM at our own origin, never a CDN', async () => {
    const { createScanDetector, ZXING_WASM_URL } = await load();
    await createScanDetector();
    const { locateFile } = overrides.mock.calls[0][0] as {
      locateFile: (p: string, prefix: string) => string;
    };
    expect(locateFile('zxing_reader.wasm', 'https://cdn.example.net/zxing-wasm/')).toBe(
      ZXING_WASM_URL
    );
    expect(ZXING_WASM_URL.startsWith('/')).toBe(true);
  });
});

describe('self-hosted wasm + CSP', () => {
  it('serves a wasm byte-identical to the installed zxing-wasm (drift guard)', async () => {
    const { ZXING_WASM_URL, ZXING_WASM_VERSION } = await load();
    const served = join(ADMIN, 'public', ZXING_WASM_URL);
    expect(existsSync(served)).toBe(true);
    const installed = join(__dirname, '../../node_modules/zxing-wasm');
    expect(JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version).toBe(
      ZXING_WASM_VERSION
    );
    const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');
    expect(sha(served)).toBe(sha(join(installed, 'dist/reader/zxing_reader.wasm')));
  });

  it("CSP allows WASM compile and the fetch from 'self', with no CDN and no unsafe-eval", () => {
    const csp = buildAdminCsp({
      nonce: 'n',
      pathname: '/stores/s/stock/scan',
      apiOrigin: 'https://api.ebda.app',
    });
    const dir = (n: string) => csp.split('; ').find(d => d.startsWith(n + ' ')) ?? '';
    expect(dir('script-src')).toContain("'wasm-unsafe-eval'");
    expect(dir('script-src')).not.toMatch(/'unsafe-eval'/);
    expect(dir('connect-src')).toContain("'self'");
    expect(csp).not.toMatch(/cdn\.example|unpkg/);
  });

  it('the scan page imports only the shared engine, not the ponyfill statically', () => {
    const page = readFileSync(join(ADMIN, 'src/app/stores/[id]/stock/scan/page.tsx'), 'utf8');
    expect(page).not.toMatch(/from 'barcode-detector|new BarcodeDetector/);
    const lib = readFileSync(join(ADMIN, 'src/lib/barcode-scanner.ts'), 'utf8');
    expect(lib).not.toMatch(/^import .*barcode-detector/m);
    expect(lib).toMatch(/await import\('barcode-detector\/ponyfill'\)/);
  });
});
