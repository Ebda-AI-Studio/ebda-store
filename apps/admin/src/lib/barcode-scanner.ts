/**
 * Shared camera-barcode engine for every admin scanner (Stock -> Scan: Receive / Pick / Count).
 *
 * The native `BarcodeDetector` Web API is absent on iOS Safari/WebKit (browser AND home-screen PWA), so
 * when it is missing (or lacks a format we need) we lazy-load the `barcode-detector` ponyfill (ZXing C++ compiled
 * to WASM). The ponyfill is dynamically imported, so it never lands in the main bundle, and its .wasm is
 * served from OUR origin (`/vendor/zxing-wasm-<ver>/`), never the ponyfill's default third-party CDN. The admin CSP already
 * carries 'wasm-unsafe-eval' (QA-109) and `connect-src 'self'` covers the fetch (tests/unit/admin-barcode-scanner.test.ts).
 */

export type ScanFormat =
  | 'ean_13'
  | 'ean_8'
  | 'upc_a'
  | 'upc_e'
  | 'code_128'
  | 'code_39'
  | 'qr_code';

export const SCAN_FORMATS: ScanFormat[] = [
  'ean_13',
  'ean_8',
  'code_128',
  'qr_code',
  'upc_a',
  'upc_e',
  'code_39',
];

/** Formats the products/labels actually use; native is only trusted when it covers all of these. */
const REQUIRED_FORMATS: ScanFormat[] = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'qr_code'];

export const ZXING_WASM_VERSION = '3.1.7';
export const ZXING_WASM_URL = `/vendor/zxing-wasm-${ZXING_WASM_VERSION}/zxing_reader.wasm`;

export interface ScanDetector {
  detect(source: ImageBitmapSource): Promise<Array<{ rawValue: string; format: string }>>;
}

export type EngineKind = 'native' | 'wasm';

interface NativeCtor {
  new (opts?: { formats?: string[] }): ScanDetector;
  getSupportedFormats?: () => Promise<string[]>;
}

/** Camera scanning needs getUserMedia (HTTPS/standalone PWA both have it); the decoder is always available. */
export function cameraScanAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

async function nativeCovers(ctor: NativeCtor): Promise<boolean> {
  if (typeof ctor.getSupportedFormats !== 'function') return false;
  try {
    const supported = await ctor.getSupportedFormats();
    return REQUIRED_FORMATS.every(f => supported.includes(f));
  } catch {
    return false;
  }
}

export async function createScanDetector(): Promise<{
  detector: ScanDetector;
  engine: EngineKind;
}> {
  const native = (globalThis as { BarcodeDetector?: NativeCtor }).BarcodeDetector;
  if (native && (await nativeCovers(native))) {
    return { detector: new native({ formats: SCAN_FORMATS }), engine: 'native' };
  }
  const { BarcodeDetector: Ponyfill, setZXingModuleOverrides } =
    await import('barcode-detector/ponyfill');
  // Before the first detector is constructed: it eagerly prepares the module with these overrides.
  setZXingModuleOverrides({
    locateFile: (path: string, prefix: string) =>
      path.endsWith('.wasm') ? ZXING_WASM_URL : prefix + path,
  });
  return { detector: new Ponyfill({ formats: SCAN_FORMATS }), engine: 'wasm' };
}
