# FDN-VENDOR-1

> Section: Ebda foundation adoption (2026-10-29)

**Ruling FDN-VENDOR-1: the shared Ebda foundation (`Whisky-11/ebda-foundation`, tag v0.1.0) is vendored at `packages/shared/src/foundation/` and imported by relative path, pinned by `foundation.lock.json` and proved by `tests/unit/foundation-parity.test.ts`.**
`@ebda/shared` compiles with `rootDir: src`, which refuses source files outside it, so a `packages/foundation` workspace would not typecheck without changing the shared build layout; the vendored copy also carries no `"type"` field so the package's CJS-mode `tsc` reads it like the rest of `src`. Prettier and eslint skip the copy (it is byte-pinned). `buyer-key.ts`, `hosts/reserved-slugs.ts`, `hosts/slug.ts`, `search/arabic-normalize.ts` and `apps/api/src/lib/wa/health-vector.ts` re-export or delegate to it with unchanged public signatures. `BRAND` stays a literal (wiring it to the foundation object added about 250 bytes to the minified brand bundle); `tests/unit/foundation-brand-parity.test.ts` pins every shared field instead. Cost if wrong: switching to a workspace later is a lock `dir` change plus a rewrite of six import paths.
