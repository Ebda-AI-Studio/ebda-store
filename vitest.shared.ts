import { type Plugin } from 'vitest/config';
import path from 'path';

/**
 * Shared module resolution for EVERY vitest config in the repo.
 *
 * This exists because it drifted. `vitest.config.ts` carried both the
 * `perAppAtAlias()` plugin and a deliberate removal of the bare `'@'` →
 * repo-root alias; `vitest.stryker.config.ts` was written earlier, kept the
 * bare `'@'`, and never got either change. The result was silent and ugly:
 * under the Stryker config, `'@/lib/x'` inside an app resolved to the REPO
 * ROOT instead of that app's `src/`, so three test files
 * (bank-reconciliation, shipping-zones-response,
 * product-recommendation-selectors) imported different modules than they do
 * under the main config and failed with inverted assertions rather than an
 * import error — which reads as "those tests are broken", not "the config is".
 *
 * Because Stryker runs the Stryker config, every mutant those three files
 * would have killed was scored as survived-or-uncovered, quietly deflating the
 * mutation baseline in `docs/test-reports/`. A resolution rule that lives in
 * one place cannot do that again.
 */
export function perAppAtAlias(): Plugin {
  const apps = ['api', 'admin', 'web', 'orders', 'marketing'];
  return {
    name: 'per-app-at-alias',
    async resolveId(source, importer) {
      if (!importer || !source.startsWith('@/')) return null;
      const normalizedImporter = importer.replace(/\\/g, '/');
      for (const app of apps) {
        const marker = `/apps/${app}/src/`;
        const idx = normalizedImporter.indexOf(marker);
        if (idx === -1) continue;
        const appSrcRoot = normalizedImporter.slice(0, idx + marker.length);
        const rewritten = path.join(appSrcRoot, source.slice(2));
        return this.resolve(rewritten, importer, { skipSelf: true });
      }
      return null;
    },
  };
}

/**
 * The workspace aliases every config shares.
 *
 * There is deliberately NO bare `'@'` → repo-root entry. Vite's
 * `resolve.alias` plugin runs before ALL user plugins regardless of `enforce`,
 * so a bare `'@'` prefix-matches `'@/...'` and rewrites it to a nonexistent
 * repo-root path before `perAppAtAlias()` above ever sees the specifier.
 * Adding it back re-breaks every app's own `'@/'` convention.
 */
export function workspaceAliases(root: string): Record<string, string> {
  return {
    '@api': path.resolve(root, './apps/api/src'),
    '@web': path.resolve(root, './apps/web/src'),
    '@admin': path.resolve(root, './apps/admin/src'),
    // orders is the third deployed frontend. It had no alias, which is a
    // large part of why it had no tests — and why a client-side auth fix
    // landed on two of three surfaces and looked complete.
    '@orders': path.resolve(root, './apps/orders/src'),
    '@database': path.resolve(root, './packages/database'),
    '@shared': path.resolve(root, './packages/shared'),
    // Pure brand module only — keeps marketing bundles free of the shared barrel.
    '@ebda/shared/brand': path.resolve(root, './packages/shared/src/brand'),
    // Pure contact-enquiry contract (marketing form + API share it; zero deps).
    '@ebda/shared/contact-enquiry': path.resolve(root, './packages/shared/src/contact-enquiry'),
    // Pure legal-policy registry (marketing imports it without the shared barrel).
    '@ebda/shared/legal': path.resolve(root, './packages/shared/src/legal'),
    // The 3D viewer subpath (apps map it in tsconfig `paths`; vite needs it here).
    '@ebda/ui/model3d': path.resolve(root, './packages/ui/src/model3d'),
    // StoreDO sources, imported under names the API's tsc cannot resolve (apps/api/src/cf/repo-modules.d.ts).
    '@ebda-src/repo': path.resolve(root, './packages/repo/src/index.ts'),
    '@ebda-src/cf-schema': path.resolve(
      root,
      './packages/cf-schema/src/store/migrations.generated.ts'
    ),
    '@ebda-src/prisma-meta': path.resolve(root, './packages/cf-schema/generated/prisma-meta.json'),
  };
}
