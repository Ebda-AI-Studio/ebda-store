# Setup for `commerce-b0.spec.ts` (manual local gate, not CI)

The spec drives the Phase B0 flow against a LOCAL stack. It never runs in CI and never against production. Nothing here is a secret; the owner password is yours to choose.

## 1. Local services

| Piece                      | Default                                              | Notes                                                                                                                                                                                       |
| -------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres                   | any local, migrated DB (`npx prisma migrate deploy`) | API runs as `ebda_app` (RLS on); give that role a local login                                                                                                                               |
| Redis                      | `redis://localhost:6379/<n>`                         |                                                                                                                                                                                             |
| API (`npm run dev:api`)    | `http://127.0.0.1:4100` (set `PORT=4100`)            | use `127.0.0.1`, the API listens on IPv4 only                                                                                                                                               |
| Web (`next dev`, apps/web) | `:3101` behind a host-shim proxy on `:3100`          | `next dev` does not run `middleware.ts`, so the proxy must add `x-store-domain: <slug>.ebda.app` from the `Host` `<slug>.localhost`; set `NEXT_PUBLIC_API_URL=http://127.0.0.1:4100/api/v1` |

## 2. Store fixture (create once; names must match the defaults or override with env)

- Owner user: any `store_admin` with a bcrypt password (email verified, status active).
- Store: slug `b0-minimal`, template `qamar`, currency `EGP`, `settings.defaultLanguage = 'ar'`, name "B0 Minimal" / "بي زيرو مينيمال".
- Category `abayas` ("Abayas" / "عبايات"); a few filler products help the "you might also like" row.
- Product **Linen Abaya**, slug `linen-abaya`, name "عباية كتان", price `149000` (minor units), status active, in that category, at least one image.
  - Options: **Colour** (Teal `#1F4E54`, Rose `#C98B8B` plus a swatch image URL, Black `#141414`), **Size** (S, M, L), **Length** (52, 54, 56; Arabic "52 سم" etc.).
  - 27 active variants (every Colour x Size x Length), inventory 10 each, EXCEPT **Teal / M / 56 = 0** (the struck-out combination).
  - Variant titles "Teal / M / 56" with Arabic twins; set `product.inventory` to the sum.
- Shipping zone "Greater Cairo" ("القاهرة الكبرى"): areas Cairo, Giza, fee `5000`, `estimatedDaysMin 1`, `estimatedDaysMax 3`, active (the delivery chip needs numbers).
- Do NOT pre-create facts, personalisation, lead time, a size chart or a COD config: the spec creates and removes them through the admin API.

## 3. Environment variables (credentials only from env)

```bash
export B0_OWNER_EMAIL=<owner email>
export B0_JWT_SECRET=<the JWT_SECRET the local API was started with>
export B0_DB_URL=<LOCAL owner database URL>  # merchants sign in at the identity service; the spec mints the owner token
# optional overrides
export B0_WEB_URL=http://b0-minimal.localhost:3100
export B0_API_URL=http://127.0.0.1:4100/api/v1
export B0_STORE_SLUG=b0-minimal
export B0_PRODUCT_SLUG=linen-abaya
```

## 4. Run

```bash
B0_REQUIRE_STACK=1 npx playwright test tests/smoke/commerce-b0.spec.ts --project=commerce-b0
```

`B0_REQUIRE_STACK=1` makes a missing stack or missing credentials a FAILURE (exit non-zero). Without it the file skips, which is not a pass: do not report a skip as one.

## Re-running

- The API's login limiter and the global limiter (a few hundred requests per IP per 15 minutes, a run uses ~100) throttle a developer machine. After many runs in a row a run fails at `owner login` with `RATE_LIMITED`; wait about 15 minutes or delete the local Redis keys `<prefix>rl:global:<ip>` and `<prefix>rl:auth:<ip>-<email>`.
- Each run tops Rose / M / 54 stock up to at least 50 (never lowers it), creates and deletes its own size chart and COD config, restores the product's facts, personalisation, lead time and chart link, and cancels its order (an open unpaid COD order counts toward the per-IP stock-hold cap). The dev PDP is cached for 60 s, so the first run after a top-up can wait up to about 90 s.
