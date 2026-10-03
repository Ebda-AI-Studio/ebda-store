# Ebda (ابدأ)

Self-serve, Shopify-style store builder for Egypt, by **Whisky 11**. Sign up, get a live store at `<slug>.ebda.app` with no human in the loop, then bring your own domain when you are ready. Arabic-first (RTL) with English, EGP pricing, and Egyptian payments and shipping behind pluggable interfaces.

Ebda is a fork of FWB (Force Website Builder, a GCC product of Force AI). FWB is the read-only `upstream` remote and is never pushed to; shared core paths are synced deliberately, see [docs/TWIN-PATHS.md](./docs/TWIN-PATHS.md).

> **Proprietary commercial software.** All rights reserved. See [LICENSE](./LICENSE).

## Where things live

| Host                                                      | What                                                       |
| --------------------------------------------------------- | ---------------------------------------------------------- |
| `ebda.app`                                                | Marketing site                                             |
| `app.ebda.app`                                            | Merchant dashboard (`apps/admin`)                          |
| `<slug>.ebda.app` + custom domains                        | Storefronts (`apps/web`)                                   |
| `orders.ebda.app`                                         | Orders PWA for fulfilment staff (`apps/orders`)            |
| `api.ebda.app`                                            | API (`apps/api`)                                           |
| `docs.` / `help.` / `status.` / `whatsapp.` (`.ebda.app`) | Developer docs, help centre, status page, WhatsApp (later) |

Brand identity (name, colours, fonts, domains, sender addresses, legal URLs) is a single source of truth: `BRAND` in `packages/shared/src/brand/index.ts`, imported from `@force/shared`. Do not re-hardcode those values; `tests/unit/no-fwb-branding.test.ts` fails on any surviving FWB/Force AI string in shipped sources.

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
  ...       Inherited FWB docs (read-only reference)
```

The `@force/*` package scope and `FORCE_*` environment variable names are inherited internal identifiers and are intentionally unchanged for now.

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
