import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cleanGitEnv, initSandboxRepo } from '../../../tests/helpers/git-env';
// @ts-expect-error plain .mjs without types
import { isTypeOnlyHit } from '../../../scripts/cf/residue-exempt.mjs';

// NZ-17 category G: prisma-lite / rpc / DO files that only NAME Prisma types are exempt from the residue gate; a real
// Postgres reference is not, and neither is anything outside the exempt prefixes.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const script = path.join(root, 'scripts/cf/decommission-neon.mjs');

describe('isTypeOnlyHit', () => {
  it('exempts the type/Decimal import, the package.json dependency and prose mentions under the exempt prefixes', () => {
    expect(
      isTypeOnlyHit('packages/repo/src/rpc/codec.ts', "import { Prisma } from '@prisma/client';")
    ).toBe(true);
    expect(
      isTypeOnlyHit(
        'packages/repo/src/x.ts',
        "import type { Prisma, Product } from '@prisma/client';"
      )
    ).toBe(true);
    expect(isTypeOnlyHit('packages/repo/package.json', '    "@prisma/client": "^6.19.3"')).toBe(
      true
    );
    expect(
      isTypeOnlyHit(
        'packages/repo/src/do/barcode.ts',
        ' * The Postgres twin takes pg_advisory_xact_lock(x)'
      )
    ).toBe(true);
    expect(
      isTypeOnlyHit(
        'apps/api/workers-do/a.test.ts',
        '// Postgres: pg_advisory_xact_lock here the DO thread'
      )
    ).toBe(true);
    expect(
      isTypeOnlyHit(
        'apps/api/workers-do/s.test.ts',
        'expect(() => client.$queryRaw).toThrow(/not available/);'
      )
    ).toBe(true);
  });
  it('still counts a real client import, raw SQL, config strings and executable pg_advisory under the exempt prefixes', () => {
    expect(
      isTypeOnlyHit('packages/repo/src/x.ts', "import { PrismaClient } from '@prisma/client';")
    ).toBe(false);
    expect(
      isTypeOnlyHit(
        'packages/repo/src/x.ts',
        "import { Prisma, PrismaClient } from '@prisma/client';"
      )
    ).toBe(false);
    expect(isTypeOnlyHit('packages/repo/src/x.ts', 'await db.$executeRaw`select 1`;')).toBe(false);
    expect(isTypeOnlyHit('packages/repo/src/x.ts', 'sql`select pg_advisory_xact_lock(1)`')).toBe(
      false
    );
    expect(isTypeOnlyHit('packages/repo/src/x.ts', '// reads process.env.DATABASE_URL')).toBe(
      false
    );
    expect(
      isTypeOnlyHit('apps/api/workers-do/x.ts', 'const u = env.HYPERDRIVE.connectionString;')
    ).toBe(false);
  });
  it('exempts nothing outside the prefixes: the same type import in apps/api/src counts', () => {
    expect(
      isTypeOnlyHit('apps/api/src/services/x.ts', "import { Prisma } from '@prisma/client';")
    ).toBe(false);
    expect(
      isTypeOnlyHit(
        'packages/database/src/client.ts',
        "import { PrismaClient } from '@prisma/client';"
      )
    ).toBe(false);
  });
});

describe('residue gate end to end (temporary git repo)', () => {
  it('counts a @prisma/client import outside the exemption and ignores the one inside it', () => {
    const { dir: d, git } = initSandboxRepo('residue-');
    const w = (f: string, t: string) => {
      fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
      fs.writeFileSync(path.join(d, f), t);
    };
    w('packages/repo/src/codec.ts', "import { Prisma } from '@prisma/client';\n");
    w('apps/api/src/svc.ts', "import { Prisma } from '@prisma/client';\n");
    git('add', '-A');
    const r = spawnSync(process.execPath, [script, 'residue', '--strict'], {
      cwd: d,
      encoding: 'utf8',
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('1 file(s)');
    expect(r.stdout).toContain('apps/api/src/svc.ts');
    expect(r.stdout).not.toContain('packages/repo/src/codec.ts');
  });
});
