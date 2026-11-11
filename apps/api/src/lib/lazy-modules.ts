// Heavy dependencies loaded at first use instead of at module load (SP4 Stage 2).
//
// On Workers every module a bundle evaluates at boot stays in the isolate's 128 MB heap whether
// or not a request ever needs it: exceljs ~6 MB, the AWS S3 client ~3 MB. A dynamic `import()` is
// bundled by wrangler's esbuild as a lazily initialised module, so the code ships in the bundle but
// its top-level runs (and its heap is allocated) on the first call. Node behaves identically
// (CommonJS `require` on first use). Callers keep `import type` for the types.
// exceljs ships as its own Worker module (Ruling BUNDLE-BUDGET-10: apps/api/src/cf/modules/exceljs.cjs, built by
// scripts/ci/gen-exceljs-workers.mjs, uploaded by the `rules` entry of wrangler.jsonc), so its ~470 KB is not part of worker.js.
// A variable specifier is left alone by the bundler: on the Worker it resolves to the uploaded module (named relative to src/,
// wrangler `find_additional_modules`), in Node (dev, tests) to the installed package.
export const loadExcelJS = async () => {
  const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator;
  const spec = nav?.userAgent === 'Cloudflare-Workers' ? './cf/modules/exceljs.cjs' : 'exceljs';
  return ((await import(/* @vite-ignore */ spec)) as { default: typeof import('exceljs') }).default;
};
export const loadS3 = () => import('./s3-bundle.js');
export const loadS3Presigner = loadS3;
// WebAuthn verification pulls in the @peculiar X.509/ASN.1 stack (attestation formats): only the passkey
// routes need it, so it is loaded on the first passkey request, not at Worker boot.
export const loadSimpleWebAuthn = () => import('@simplewebauthn/server');
