// Section 2.7 / 2.8: SQLite row guards that stay triggers.
import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { expectThrows, openDb } from './helpers';

let db: DatabaseSync;
beforeEach(() => {
  db = openDb('store');
});

const NOW = () => Date.now();

describe('fiscal_documents immutability', () => {
  const insert = (id = 'f1', retainUntil = NOW() + 86_400_000) =>
    db
      .prepare(
        `INSERT INTO fiscal_documents (id, store_id, order_id, doc_type, serial, number, status, issued_at, currency, net_amount, vat_amount, total_amount, vat_rate_bps, seller_trn, payload, retain_until)
         VALUES (?, 's1', 'o1', 'receipt', 1, 'INV-1', 'issued', ?, 'EGP', 100, 14, 114, 1400, 'T', '{}', ?)`
      )
      .run(id, NOW(), retainUntil);

  it('refuses to change an issued document, to delete a retained one, or to un-cancel; allows issued -> cancelled', () => {
    insert();
    expectThrows(
      () => db.prepare(`UPDATE fiscal_documents SET total_amount = 1 WHERE id = 'f1'`).run(),
      /immutable/
    );
    expectThrows(
      () => db.prepare(`DELETE FROM fiscal_documents WHERE id = 'f1'`).run(),
      /retained/
    );
    db.prepare(`UPDATE fiscal_documents SET status = 'cancelled' WHERE id = 'f1'`).run();
    expectThrows(
      () => db.prepare(`UPDATE fiscal_documents SET status = 'issued' WHERE id = 'f1'`).run(),
      /issued -> cancelled/
    );
  });

  it('allows deleting a document after retain_until', () => {
    insert('f2', NOW() - 1000);
    db.prepare(`DELETE FROM fiscal_documents WHERE id = 'f2'`).run();
    expect(db.prepare(`SELECT count(*) c FROM fiscal_documents`).get()).toEqual({ c: 0 });
  });
});

describe('gold price guard (Ruling B5-13)', () => {
  const gold = `INSERT INTO products (id, store_id, name, slug, price, pricing_mode, gold_karat, gold_weight_mg, making_charge_type, making_charge_value, gold_margin_bps) VALUES (?, 's1', 'n', ?, 100, 'gold_rate', 21, 5000, 'fixed', 0, 0)`;

  it('refuses a gold-priced product written outside the repricer, allows it inside the flag, and ignores fixed products', () => {
    expectThrows(() => db.prepare(gold).run('g1', 'g1'), /GOLD_PRICE_MANAGED/);
    db.prepare(`INSERT INTO do_flags (name, value) VALUES ('gold_reprice', 1)`).run();
    db.prepare(gold).run('g1', 'g1');
    db.prepare(`UPDATE products SET price = 200 WHERE id = 'g1'`).run();
    db.prepare(`UPDATE do_flags SET value = 0 WHERE name = 'gold_reprice'`).run();
    expectThrows(
      () => db.prepare(`UPDATE products SET price = 300 WHERE id = 'g1'`).run(),
      /GOLD_PRICE_MANAGED/
    );
    db.prepare(`UPDATE products SET name = 'renamed' WHERE id = 'g1'`).run(); // non-price columns stay free
    db.prepare(
      `INSERT INTO products (id, store_id, name, slug, price) VALUES ('fx', 's1', 'n', 'fx', 5)`
    ).run();
    db.prepare(`UPDATE products SET price = 6 WHERE id = 'fx'`).run();
  });

  it('guards variants through the product mode', () => {
    db.prepare(`INSERT INTO do_flags (name, value) VALUES ('gold_reprice', 1)`).run();
    db.prepare(gold).run('g2', 'g2');
    db.prepare(
      `INSERT INTO product_variants (id, product_id, title, price) VALUES ('v1', 'g2', 't', 50)`
    ).run();
    db.prepare(`UPDATE do_flags SET value = 0 WHERE name = 'gold_reprice'`).run();
    expectThrows(
      () => db.prepare(`UPDATE product_variants SET price = 60 WHERE id = 'v1'`).run(),
      /GOLD_PRICE_MANAGED/
    );
    expectThrows(
      () =>
        db
          .prepare(
            `INSERT INTO product_variants (id, product_id, title, price) VALUES ('v2', 'g2', 't', 50)`
          )
          .run(),
      /GOLD_PRICE_MANAGED/
    );
  });
});

describe('commerce_outcomes is append-only (CI-1)', () => {
  it('refuses delete and edits, allows only the export stamp, and dedupes per order+kind+source', () => {
    const ins = db.prepare(
      `INSERT INTO commerce_outcomes (id, store_id, kind, order_id, buyer_key, occurred_at) VALUES (?, 's1', 'cod_refused', ?, 'abc', ?)`
    );
    ins.run('c1', 'o1', NOW());
    expectThrows(
      () => db.prepare(`DELETE FROM commerce_outcomes WHERE id = 'c1'`).run(),
      /append-only/
    );
    expectThrows(
      () => db.prepare(`UPDATE commerce_outcomes SET kind = 'delivered' WHERE id = 'c1'`).run(),
      /append-only/
    );
    db.prepare(`UPDATE commerce_outcomes SET exported_at = ? WHERE id = 'c1'`).run(NOW());
    expectThrows(() => ins.run('c2', 'o1', NOW()), /UNIQUE/);
    expectThrows(
      () =>
        db
          .prepare(
            `INSERT INTO commerce_outcomes (id, store_id, kind, occurred_at) VALUES ('c3', 's1', 'nonsense', 1)`
          )
          .run(),
      /CHECK/
    );
  });
});
