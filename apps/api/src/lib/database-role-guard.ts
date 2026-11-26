/**
 * Node-shell boot-time DB role guard (Finding #5 MED, hardened by FIX-003
 * 2026-10-07). The Workers shell has no guard (it has no Postgres); this one covers `index.ts` (Docker,
 * `npm run dev`, the Node integration tier).
 *
 * If DATABASE_URL connects as a role that bypasses RLS (BYPASSRLS or a
 * superuser), every store can read every other store's data. The check used
 * to run fire-and-forget AFTER `listen()` — the API was already serving — and
 * a failed query only logged a warning, so the guard failed OPEN. It now runs
 * and is awaited BEFORE `listen()`, and in production an unverifiable role is
 * fatal exactly like an unsafe one.
 *
 * `ALLOW_BYPASSRLS_ROLE=true` stays as the explicit, LOUD escape hatch
 * inherited from Ebda (whose production runs as `neondb_owner`). It accepts a
 * bypassing role only — never an unverifiable one. Ebda's intended runtime
 * role is `ebda_app` (NOBYPASSRLS, Ruling R-EBDA-002).
 */
import type logger from './logger';

export interface DatabaseRoleRow {
  currentUser: string | null;
  rolbypassrls: boolean;
  rolsuper: boolean;
}

export interface DatabaseRoleGuardDeps {
  /** `SELECT current_user, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user` */
  queryRole: () => Promise<DatabaseRoleRow[]>;
  nodeEnv: string;
  /** `process.env.ALLOW_BYPASSRLS_ROLE === 'true'` */
  allowBypassRls: boolean;
  log: Pick<typeof logger, 'info' | 'warn' | 'error' | 'fatal'>;
  exit: (code: number) => void;
}

export type DatabaseRoleGuardOutcome =
  | 'safe'
  | 'bypass-allowed'
  | 'non-production-warned'
  | 'exited';

export async function enforceDatabaseRoleGuard(
  deps: DatabaseRoleGuardDeps
): Promise<DatabaseRoleGuardOutcome> {
  const isProduction = deps.nodeEnv === 'production';

  const refuse = (reason: string, detail: Record<string, unknown>): DatabaseRoleGuardOutcome => {
    if (isProduction) {
      deps.log.fatal(detail, `[SECURITY FATAL] ${reason} — refusing to serve traffic.`);
      deps.exit(1);
      return 'exited';
    }
    deps.log.warn(detail, `[SECURITY WARN] ${reason} (non-production: continuing).`);
    return 'non-production-warned';
  };

  let rows: DatabaseRoleRow[];
  try {
    rows = await deps.queryRole();
  } catch (err) {
    return refuse('DB role check query failed — the connected role cannot be verified', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  const row = rows.length === 1 ? rows[0] : undefined;
  if (!row || !row.currentUser) {
    return refuse('DB role check returned no single pg_roles row for current_user', {
      rowCount: rows.length,
    });
  }

  const rolbypassrls = row.rolbypassrls === true;
  const rolsuper = row.rolsuper === true;
  // Positive, always-on record of the role the API actually connected as
  // (#1940). CI greps `current_user=ebda_app rolbypassrls=false rolsuper=false` in this
  // exact line after /health is up — keep that substring stable. Values are in
  // the message so the grep works under pino-pretty too. A role name is not a
  // secret.
  deps.log.info(
    { currentUser: row.currentUser, rolbypassrls, rolsuper },
    `[SECURITY] DB role check: current_user=${row.currentUser} rolbypassrls=${rolbypassrls} rolsuper=${rolsuper}`
  );

  if (!rolbypassrls && !rolsuper) return 'safe';

  if (isProduction && deps.allowBypassRls) {
    // The explicit escape hatch. Loud on every boot so it can never become
    // the quiet default: RLS tenant isolation is OFF for this process.
    deps.log.error(
      { currentUser: row.currentUser, rolbypassrls, rolsuper, allowBypassRls: true },
      `[SECURITY] ALLOW_BYPASSRLS_ROLE=true — serving as ${row.currentUser}, a role that ` +
        'BYPASSES RLS. Tenant isolation is NOT enforced by the database. Remove the hatch ' +
        'and point DATABASE_URL at ebda_app.'
    );
    return 'bypass-allowed';
  }

  return refuse(
    'DATABASE_URL connects as a role that bypasses RLS (BYPASSRLS or superuser) — ' +
      'all RLS tenant isolation is disabled. Switch DATABASE_URL to the non-owner role ' +
      '(ebda_app) and redeploy, or set ALLOW_BYPASSRLS_ROLE=true to explicitly accept this',
    { currentUser: row.currentUser, rolbypassrls, rolsuper }
  );
}

/**
 * Await the guard, then start listening — never the other way round. A guard
 * that called `exit` (production refusal) never reaches `listen`.
 */
export async function listenAfterDatabaseRoleGuard(
  deps: DatabaseRoleGuardDeps,
  listen: () => void
): Promise<DatabaseRoleGuardOutcome> {
  const outcome = await enforceDatabaseRoleGuard(deps);
  if (outcome !== 'exited') listen();
  return outcome;
}
