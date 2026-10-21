/**
 * zxing-wasm for tests, with the wasm bytes read from disk and handed over
 * directly. Its default loader `fetch`es the wasm, which fails in a vitest
 * worker when an earlier test in the same run has replaced global fetch.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';

const wasmBinary = readFileSync(
  join(__dirname, '../../node_modules/zxing-wasm/dist/reader/zxing_reader.wasm')
);
const ready = prepareZXingModule({ overrides: { wasmBinary }, fireImmediately: true });

/** Decode Code 128 barcodes from encoded image bytes (PNG). */
export async function decodeCode128(image: Uint8Array): Promise<string[]> {
  await ready;
  const res = await readBarcodes(new Blob([image], { type: 'image/png' }), {
    formats: ['Code128'],
    tryHarder: true,
  });
  return res.map(r => r.text);
}
