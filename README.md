# Ebda Store (ابدأ ستور)

Self-serve, Shopify-style store builder for Egypt, by **Ebda AI Studio**. Sign up, get a live store at `<slug>.ebda.app` with no human in the loop, then bring your own domain when you are ready. Arabic-first (RTL) with English, EGP pricing, and Egyptian payments and shipping behind pluggable interfaces.

> **Proprietary commercial software.** All rights reserved. See [LICENSE](./LICENSE).

## Where things live

| Host                                        | What                                                  |
| ------------------------------------------- | ----------------------------------------------------- |
| `ebda.app`                                  | Marketing site                                        |
| `store.ebda.app`                            | Merchant dashboard (`apps/admin`)                     |
| `<slug>.ebda.app` + custom domains          | Storefronts (`apps/web`)                              |
| `orders.ebda.app`                           | Orders PWA for fulfilment staff (`apps/orders`)       |
| `api.ebda.app`                              | API (`apps/api`)                                      |
| `docs.` / `help.` / `status.` (`.ebda.app`) | Developer docs, help centre, status page              |
| `wa.ebda.app`                               | Ebda Chat (own Worker; API base `/api/v1`)            |
| `accounts.ebda.app`                         | Shared identity service (one login for every product) |

Brand identity (name, colours, fonts, domains, sender addresses, legal URLs) is a single source of truth: `BRAND` in `packages/shared/src/brand/index.ts`, imported from `@ebda/shared`. Do not re-hardcode those values; `tests/unit/no-force-branding.test.ts` fails on any inherited brand, tenant, domain, country or currency string anywhere in the tracked repository (migration history excepted).

## Repository layout

```
apps/
  api/      Express + Prisma API (moving to Cloudflare Workers, see docs/ebda/design/)
  web/      Next.js storefront + platform host
  admin/    Next.js merchant dashboard
  orders/   Next.js orders PWA
packages/
  database/ Prisma schema, migrations, RLS helpers
  shared/   Types, schemas, money/tax helpers, brand (BRAND)
  ui/       Shared React components
docs/
  ebda/     Ebda plans, research, design, brand brief  (Ebda-only)
  ...       Inherited Ebda docs (read-only reference)
```

Workspace packages use the `@ebda/*` scope. The `FORCE_*` environment variable names are inherited internal identifiers and are intentionally unchanged for now.

## Develop

Node 22.

```bash
HUSKY=0 npm ci
npm run build -w packages/database && npm run build -w packages/shared   # dist/ is needed by typecheck + tests
npm run typecheck
npm run lint
npm run test:unit
npm run dev:web      # or dev:api / dev:admin / dev:orders
```

Commits use lowercase conventional-commit subjects (commitlint). Money is integer minor units; tenant isolation rules are in [CLAUDE.md](./CLAUDE.md) and `docs/RULINGS.md`.

## Plans and status

- Program plan: [docs/ebda/plans/2026-10-03-ebda-program-plan.md](./docs/ebda/plans/2026-10-03-ebda-program-plan.md)
- Status: [docs/ebda/plans/STATUS.md](./docs/ebda/plans/STATUS.md)
- Brand brief: [docs/ebda/brand/ebda-brief-v2.html](./docs/ebda/brand/ebda-brief-v2.html)
