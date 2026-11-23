/**
 * FIX-003 — the DB role guard runs and is awaited BEFORE listen(), fails
 * CLOSED in production, covers superusers, and keeps the explicit
 * ALLOW_BYPASSRLS_ROLE hatch (inherited from Ebda). Node shell only; the
 * Workers shell has no guard (no Postgres).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  listenAfterDatabaseRoleGuard,
  type DatabaseRoleGuardDeps,
  type DatabaseRoleRow,
} from '../../apps/api/src/lib/database-role-guard';

function harness(opts: {
  rows?: DatabaseRoleRow[];
  queryError?: Error;
  nodeEnv?: string;
  allowBypassRls?: boolean;
}) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() };
  const exit = vi.fn();
  const listen = vi.fn();
  const deps: DatabaseRoleGuardDeps = {
    queryRole: opts.queryError
      ? async () => {
          throw opts.queryError;
        }
      : async () => opts.rows ?? [],
    nodeEnv: opts.nodeEnv ?? 'production',
    allowBypassRls: opts.allowBypassRls ?? false,
    log: log as unknown as DatabaseRoleGuardDeps['log'],
    exit,
  };
  return { deps, log, exit, listen };
}

const owner: DatabaseRoleRow = { currentUser: 'neondb_owner', rolbypassrls: true, rolsuper: false };
const superuser: DatabaseRoleRow = { currentUser: 'postgres', rolbypassrls: false, rolsuper: true };
const app: DatabaseRoleRow = { currentUser: 'ebda_app', rolbypassrls: false, rolsuper: false };

describe('listenAfterDatabaseRoleGuard (FIX-003)', () => {
  it('bypass role WITHOUT the hatch in production → exit(1), never listens', async () => {
    const h = harness({ rows: [owner] });
    expect(await listenAfterDatabaseRoleGuard(h.deps, h.listen)).toBe('exited');
    expect(h.exit).toHaveBeenCalledWith(1);
    expect(h.listen).not.toHaveBeenCalled();
  });

  it('superuser WITHOUT the hatch in production → exit(1), never listens', async () => {
    const h = harness({ rows: [superuser] });
    expect(await listenAfterDatabaseRoleGuard(h.deps, h.listen)).toBe('exited');
    expect(h.exit).toHaveBeenCalledWith(1);
    expect(h.listen).not.toHaveBeenCalled();
  });

  it('query error in production → exit(1) (fail closed), never listens', async () => {
    const h = harness({ queryError: new Error('connection reset') });
    expect(await listenAfterDatabaseRoleGuard(h.deps, h.listen)).toBe('exited');
    expect(h.exit).toHaveBeenCalledWith(1);
    expect(h.listen).not.toHaveBeenCalled();
    expect(h.log.fatal).toHaveBeenCalled();
  });

  it('no pg_roles row in production → exit(1)', async () => {
    const h = harness({ rows: [] });
    expect(await listenAfterDatabaseRoleGuard(h.deps, h.listen)).toBe('exited');
    expect(h.listen).not.toHaveBeenCalled();
  });

  it('ALLOW_BYPASSRLS_ROLE hatch → boots, and says so LOUDLY (error level)', async () => {
    const h = harness({ rows: [owner], allowBypassRls: true });
    expect(await listenAfterDatabaseRoleGuard(h.deps, h.listen)).toBe('bypass-allowed');
    expect(h.exit).not.toHaveBeenCalled();
    expect(h.listen).toHaveBeenCalledTimes(1);
    expect(h.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ currentUser: 'neondb_owner', allowBypassRls: true }),
      expect.stringContaining('ALLOW_BYPASSRLS_ROLE=true')
    );
  });

  it('the hatch does NOT excuse an unverifiable role', async () => {
    const h = harness({ queryError: new Error('timeout'), allowBypassRls: true });
    expect(await listenAfterDatabaseRoleGuard(h.deps, h.listen)).toBe('exited');
    expect(h.listen).not.toHaveBeenCalled();
  });

  it('safe role → boots, logs the line CI greps', async () => {
    const h = harness({ rows: [app] });
    expect(await listenAfterDatabaseRoleGuard(h.deps, h.listen)).toBe('safe');
    expect(h.exit).not.toHaveBeenCalled();
    expect(h.listen).toHaveBeenCalledTimes(1);
    const line = h.log.info.mock.calls[0]?.[1] as string;
    expect(line).toContain(
      'DB role check: current_user=ebda_app rolbypassrls=false rolsuper=false'
    );
  });

  it('non-production: a bypass role or query error warns and still boots', async () => {
    for (const opts of [{ rows: [owner] }, { queryError: new Error('x') }]) {
      const h = harness({ ...opts, nodeEnv: 'development' });
      expect(await listenAfterDatabaseRoleGuard(h.deps, h.listen)).toBe('non-production-warned');
      expect(h.exit).not.toHaveBeenCalled();
      expect(h.listen).toHaveBeenCalledTimes(1);
    }
  });

  it('listen is not called until the role query has resolved', async () => {
    const h = harness({ rows: [app] });
    let resolveQuery!: (rows: DatabaseRoleRow[]) => void;
    h.deps.queryRole = () => new Promise(r => (resolveQuery = r));
    const done = listenAfterDatabaseRoleGuard(h.deps, h.listen);
    await new Promise(r => setTimeout(r, 0));
    expect(h.listen).not.toHaveBeenCalled();
    resolveQuery([app]);
    await done;
    expect(h.listen).toHaveBeenCalledTimes(1);
  });
});

describe('apps/api/src/index.ts boot wiring', () => {
  const src = readFileSync(resolve(__dirname, '../../apps/api/src/index.ts'), 'utf8');

  it('listens ONLY through listenAfterDatabaseRoleGuard', () => {
    expect(src).toMatch(/listenAfterDatabaseRoleGuard\(/);
    // Exactly one listen call, and it is the guard's continuation.
    expect(src.match(/\.listen\(/g)).toHaveLength(1);
    expect(src).toMatch(/\(\) => server\.listen\(config\.port, onListening\)/);
  });

  it('checks superuser as well as BYPASSRLS, and keeps the hatch wired', () => {
    expect(src).toMatch(/rolbypassrls, rolsuper/);
    expect(src).toMatch(/allowBypassRls: process\.env\.ALLOW_BYPASSRLS_ROLE === 'true'/);
  });
});
