// Self-service gap A7: the provider activation ledger (`activation.*` rows of provider_verification_events) is
// append-only on D1 as well as Postgres; ordinary evidence rows keep their old behaviour.
import { describe, expect, it } from 'vitest';
import { expectThrows, openDb } from './helpers';

const insert = (db: ReturnType<typeof openDb>, id: string, op: string) =>
  db
    .prepare(
      `INSERT INTO "provider_verification_events" ("id","provider","source_store_id","op","ok","mode","counted","created_at") VALUES (?, 'kashier', 'store-a', ?, 1, 'sandbox', 0, '2026-11-14T00:00:00.000Z')`
    )
    .run(id, op);

describe('D1 activation ledger is append-only', () => {
  const db = openDb('platform', 2);

  it('refuses UPDATE and DELETE of an activation.* row, and allows INSERT', () => {
    insert(db, 'l1', 'activation.deactivated');
    expectThrows(
      () =>
        db
          .prepare(
            `UPDATE "provider_verification_events" SET "op" = 'activation.unblocked' WHERE "id" = 'l1'`
          )
          .run(),
      /append-only/
    );
    expectThrows(
      () => db.prepare(`DELETE FROM "provider_verification_events" WHERE "id" = 'l1'`).run(),
      /append-only/
    );
    expect(
      db.prepare(`SELECT "op" FROM "provider_verification_events" WHERE "id" = 'l1'`).get()
    ).toEqual({
      op: 'activation.deactivated',
    });
  });

  it('leaves other evidence rows editable (a release writing them is never rejected)', () => {
    insert(db, 'e1', 'payment_confirmed');
    db.prepare(`UPDATE "provider_verification_events" SET "counted" = 1 WHERE "id" = 'e1'`).run();
    db.prepare(`DELETE FROM "provider_verification_events" WHERE "id" = 'e1'`).run();
  });
});
