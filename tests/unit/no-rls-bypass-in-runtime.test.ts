/**
 * The API runtime has no RLS bypass (R-EBDA-001, SP4 Stage 1a).
 *
 * Under strict RLS the runtime role `ebda_app` is NOBYPASSRLS and the policies read no
 * `app.bypass_rls` setting. The ways to see across stores are narrow and named:
 * SECURITY DEFINER functions (`apps/api/src/lib/definer.ts`), `acrossStores` /
 * `withStore` (one tenant transaction per store), and, for ONE job, an owner-role connection
 * (`withOwnerTx`, the R2 orphan sweep, which refuses to run on the app role).
 *
 * This is a source scan that keeps it that way: nothing under apps/api/src may import
 * `withRlsBypass` / `withOwnerTx` except the allow-listed sweep, and no source may set or read
 * the removed `app.bypass_rls` GUC. Mutation record: importing `withRlsBypass` into any service
 * turns the first test red.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sourceFiles, stripComments } from './helpers/source-scan';

const ROOT = path.resolve(__dirname, '../..');

/** Files allowed to use the owner-role escape hatch, with the reason. */
const ALLOWED_OWNER_TX: Record<string, string> = {
  'apps/api/src/lib/inngest/functions/r2-orphan-sweep.ts':
    'bulk R2 delete decision needs EVERY store row; runs on an owner-role connection and refuses the app role',
};

const IMPORTS_BYPASS = /import\s*(?:type\s*)?\{[^}]*\b(withRlsBypass|withOwnerTx)\b[^}]*\}\s*from/;

describe('no RLS bypass in the API runtime', () => {
  it('the detector sees an import of the bypass helpers', () => {
    expect(IMPORTS_BYPASS.test("import { prisma, withRlsBypass } from '@ebda/database';")).toBe(
      true
    );
    expect(IMPORTS_BYPASS.test("import { withOwnerTx } from '@ebda/database';")).toBe(true);
    expect(IMPORTS_BYPASS.test("import { prisma, withStore } from '@ebda/database';")).toBe(false);
  });

  it('only the allow-listed owner-role job imports withRlsBypass / withOwnerTx', () => {
    const offenders: string[] = [];
    for (const f of sourceFiles()) {
      const rel = path.relative(ROOT, f);
      if (!rel.startsWith('apps/api/src/')) continue;
      if (IMPORTS_BYPASS.test(stripComments(fs.readFileSync(f, 'utf8')))) {
        if (!(rel in ALLOWED_OWNER_TX)) offenders.push(rel);
      }
    }
    expect(
      offenders,
      `RLS bypass imported outside the allow-list:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('every allow-listed file still exists and still needs the exception', () => {
    for (const rel of Object.keys(ALLOWED_OWNER_TX)) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      expect(IMPORTS_BYPASS.test(stripComments(src)), `${rel} no longer imports it`).toBe(true);
    }
  });

  it('nothing sets or reads the removed app.bypass_rls GUC', () => {
    const offenders: string[] = [];
    for (const f of sourceFiles()) {
      const rel = path.relative(ROOT, f);
      if (!/^(apps|packages)\//.test(rel)) continue;
      if (/app\.bypass_rls/.test(stripComments(fs.readFileSync(f, 'utf8')))) offenders.push(rel);
    }
    // Old migrations (SQL) are history, not runtime: they are excluded by the scan roots (src only).
    expect(offenders, `app.bypass_rls referenced in:\n${offenders.join('\n')}`).toEqual([]);
  });

  // ---- Code-level tenant guard hatches (R-EBDA-003) ----

  it('no runtime source builds the owner-role client (it has no tenant guard)', () => {
    const OWNER_CLIENT = /role:\s*['"]owner['"]/;
    expect(OWNER_CLIENT.test("createPrismaClient({ connectionString: u, role: 'owner' })")).toBe(
      true
    );
    const offenders: string[] = [];
    for (const f of sourceFiles()) {
      const rel = path.relative(ROOT, f);
      if (!rel.startsWith('apps/api/src/')) continue;
      if (OWNER_CLIENT.test(stripComments(fs.readFileSync(f, 'utf8')))) offenders.push(rel);
    }
    expect(offenders, `owner-role client built in runtime code:\n${offenders.join('\n')}`).toEqual(
      []
    );
  });

  it('the platform-operator hatch is used only by the enumerated super-admin surfaces', () => {
    const ALLOWED_PLATFORM_OPERATOR: Record<string, string> = {
      'apps/api/src/routes/admin.routes.ts':
        'super-admin router: platform directory (stores, users)',
      'apps/api/src/services/store.service.ts':
        'super-admin store hard-delete: the owner account cleanup',
      'apps/api/src/routes/store.routes.ts': 'super-admin GET /stores: every store with its owner',
      'apps/api/src/lib/platform-scope.ts':
        'the one wrapper (asOperator) of the hatch: provider activation, legal-notice fan-out and the platform hub call it, and with the platform families on D1 it checks the operator with the identity service instead',
    };
    const offenders: string[] = [];
    const used = new Set<string>();
    for (const f of sourceFiles()) {
      const rel = path.relative(ROOT, f);
      if (!rel.startsWith('apps/api/src/')) continue;
      if (/\basPlatformOperator\s*\(/.test(stripComments(fs.readFileSync(f, 'utf8')))) {
        used.add(rel);
        if (!(rel in ALLOWED_PLATFORM_OPERATOR)) offenders.push(rel);
      }
    }
    expect(
      offenders,
      `asPlatformOperator outside the allow-list:\n${offenders.join('\n')}`
    ).toEqual([]);
    expect(Object.keys(ALLOWED_PLATFORM_OPERATOR).filter(r => !used.has(r))).toEqual([]);
  });
});
