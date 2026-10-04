// Heavy dependencies loaded at first use instead of at module load (SP4 Stage 2).
//
// On Workers every module a bundle evaluates at boot stays in the isolate's 128 MB heap whether
// or not a request ever needs it: exceljs ~6 MB, the AWS S3 client ~3 MB. A dynamic `import()` is
// bundled by wrangler's esbuild as a lazily initialised module, so the code ships in the bundle but
// its top-level runs (and its heap is allocated) on the first call. Node behaves identically
// (CommonJS `require` on first use). Callers keep `import type` for the types.
export const loadExcelJS = async () => (await import('exceljs')).default;
export const loadS3 = () => import('./s3-bundle.js');
export const loadS3Presigner = loadS3;
