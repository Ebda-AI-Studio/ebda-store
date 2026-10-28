/**
 * FOUNDING-1: the first 20 paying stores get a free month, which moves a store's period end. Suites that assert exact
 * period ends must not be at the mercy of that global counter, so they fill the 20 slots with inert rows first.
 * `exec` runs one raw statement on a role that may write billing_grants (the fixture / owner connection).
 */
export async function exhaustFoundingSlots(exec: (sql: string) => Promise<unknown>): Promise<void> {
  await exec(
    `INSERT INTO billing_grants (id, kind, beneficiary_id, months, status, idempotency_key)
     SELECT gen_random_uuid()::text, 'founding', 'test-filler-' || g, 1, 'applied', 'founding:test-filler-' || g
     FROM generate_series(1, 20) g ON CONFLICT (idempotency_key) DO NOTHING`
  );
}
