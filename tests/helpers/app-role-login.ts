/**
 * `ALTER ROLE ebda_app ... PASSWORD` for the integration suites, safe on a SHARED Postgres cluster.
 *
 * Roles are cluster-global, so every integration file (and every agent/CI job pointed at one cluster) rewrites
 * the same `pg_authid` row. Two ALTER ROLEs at once make Postgres answer `tuple concurrently updated`, and the
 * file's `beforeAll` fails, skipping every test in it (measured 2026-10-27 on the shared PG17: 3 writers x 150
 * ALTERs -> 70 errors). The password is the same in every file, so retrying the loser is correct.
 */
type Raw = { $executeRawUnsafe(sql: string): Promise<unknown> };

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
export const isConcurrentRoleUpdate = (e: unknown) =>
  /tuple concurrently updated/i.test(e instanceof Error ? e.message : String(e));

export async function setAppRoleLogin(client: Raw, password: string, attempts = 10): Promise<void> {
  const sql = `ALTER ROLE ebda_app WITH LOGIN PASSWORD '${password.replace(/'/g, "''")}'`;
  for (let i = 1; ; i++) {
    try {
      await client.$executeRawUnsafe(sql);
      return;
    } catch (e) {
      if (!isConcurrentRoleUpdate(e) || i >= attempts) throw e;
      await sleep(25 * i + Math.floor(Math.random() * 50));
    }
  }
}
