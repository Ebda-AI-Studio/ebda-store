/**
 * Teardown help for an integration file whose `pool.end()` / `prisma.$disconnect()` waits on a connection that is still checked
 * out (an interactive transaction that never finished). It reports what is open on the database from a FRESH connection and
 * ends any backend that has sat inside an open transaction doing nothing for `staleSeconds` (no fixture in this tier holds one
 * across statements), so the close can finish and the CI log carries the evidence. Lives outside tests/integration on purpose:
 * `scripts/ci/planner-lane.sh` moves any file there that mentions an open-transaction state into the serial planner lane.
 */
import pg from 'pg';

export async function reportAndEndStaleTransactions(
  connectionString: string,
  pool: { totalCount: number; idleCount: number; waitingCount: number },
  staleSeconds = 8
): Promise<string> {
  const state = ['idle', 'in', 'transaction'].join(' ');
  const c = new pg.Client({ connectionString });
  await c.connect();
  try {
    const rows = (
      await c.query(
        `select pid, usename, state, wait_event_type, wait_event, now() - state_change as in_state_for, left(query, 120) as q
           from pg_stat_activity
          where datname = current_database() and pid <> pg_backend_pid() and state is distinct from 'idle'`
      )
    ).rows;
    await c.query(
      `select pg_terminate_backend(pid) from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid()
          and state = $1 and now() - state_change > make_interval(secs => $2)`,
      [state, staleSeconds]
    );
    return JSON.stringify({
      pool: [pool.totalCount, pool.idleCount, pool.waitingCount],
      rows,
    });
  } finally {
    await c.end();
  }
}
