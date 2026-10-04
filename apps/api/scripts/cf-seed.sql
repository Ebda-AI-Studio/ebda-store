-- Two tenants for the Stage 1 exit test (and `wrangler dev` poking). Run as the DB OWNER
-- (RLS applies to ebda_app only). Idempotent: removes and recreates its own rows.
-- Product names / slugs carry the store tag, so a cross-tenant leak is detectable by string match.
BEGIN;
DELETE FROM cart_items WHERE cart_id IN (SELECT id FROM carts WHERE store_id IN ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'));
DELETE FROM carts WHERE store_id IN ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222');
DELETE FROM products WHERE store_id IN ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222');
DELETE FROM categories WHERE store_id IN ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222');
DELETE FROM stores WHERE id IN ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222');
DELETE FROM users WHERE id = '99999999-9999-4999-8999-999999999999';

INSERT INTO users (id, email, password_hash, first_name, last_name, updated_at)
VALUES ('99999999-9999-4999-8999-999999999999', 'owner@exit-test.invalid', 'x', 'Exit', 'Test', now());

INSERT INTO stores (id, name, slug, owner_id, updated_at) VALUES
  ('11111111-1111-4111-8111-111111111111', 'Alpha Store', 'alpha', '99999999-9999-4999-8999-999999999999', now()),
  ('22222222-2222-4222-8222-222222222222', 'Bravo Store', 'bravo', '99999999-9999-4999-8999-999999999999', now());

INSERT INTO products (id, store_id, name, slug, price, status, inventory, updated_at)
SELECT gen_random_uuid()::text, s.id, s.tag || '-product-' || n, s.tag || '-product-' || n, 1000 * n, 'active', 100, now()
FROM (VALUES ('11111111-1111-4111-8111-111111111111', 'ALPHA'), ('22222222-2222-4222-8222-222222222222', 'BRAVO')) AS s(id, tag),
     generate_series(1, 6) AS n;
COMMIT;
