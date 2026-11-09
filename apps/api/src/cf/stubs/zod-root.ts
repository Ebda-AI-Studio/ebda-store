// `zod` (the package root) for the Workers bundle. Ruling BUNDLE-BUDGET-9 (docs/rulings/BUNDLE-BUDGET-9.md).
//
// zod 4's root does `import * as z from './v4/classic/external.js'; export { z }`, and that namespace carries
// `export * as locales` (64 locale files) and `export * as core` (which carries `locales` again). esbuild cannot tree-shake
// members of a namespace that is re-exported as a value, so ONE `import { z } from 'zod'` (apps/api/src/contracts/wa-v1.ts,
// byte-pinned to the WhatsApp repo, so the import cannot be rewritten there) put every locale into worker.js: 261 KB raw,
// measured 2026-11-09, which left the gzip budget with no headroom.
//
// wrangler.jsonc aliases EXACTLY `zod` here (wrangler's alias matches the whole specifier: `zod/v3`, `zod/v4` are untouched).
// Named imports (`import { ZodOptional } from 'zod'`, the MCP SDK) come from the real `zod/v4` re-export below, so classes are
// the same instances everywhere. The `z` namespace comes from ./zod-namespace.ts: identical to zod's, minus `locales` and
// `core` (undefined there). The default error map stays English: zod's classic schemas set it, not the locales namespace.
// Pinned by tests/unit/ops/zod-root-alias.test.ts.
export * from 'zod/v4';
import * as z from './zod-namespace';
export { z, z as default };
