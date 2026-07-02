# Dependencies, Type-Safety & Code-Quality Audit — 2026-07-02

Scope: dependency vulnerabilities/hygiene, TypeScript type-safety, code-quality (god files,
dead code, error handling, console logs, TODO markers), npm override correctness.
Worktree: `force-website-builder__fix-deep-audit-2026-07-02`, origin/main HEAD `2332c4d5`.
Read-only audit — no source files modified. `node_modules` did not exist at audit start;
`npm ci` + `npm run db:generate` + package builds were run (read-only w.r.t. source, standard
build outputs only) to enable `npm audit`, `tsc`, and `npm ls` introspection.

**Brief-vs-reality note:** the dispatch brief described `apps/api` as Fastify. The actual
code (`apps/api/src/routes/*.routes.ts`) is **Express 4** (`import { Router } from 'express'`).
Not a defect — just correcting the record for future audits.

## Severity counts

| Severity                  | Count |
| ------------------------- | ----- |
| Critical                  | 0     |
| High                      | 1     |
| Medium                    | 4     |
| Low                       | 5     |
| Positive (verified clean) | 5     |

## `npm audit` tally

| Scope                                     | Critical | High | Moderate | Low | Info |
| ----------------------------------------- | -------- | ---- | -------- | --- | ---- |
| Full tree (`npm audit --audit-level=low`) | 0        | 0    | 2        | 0   | 0    |
| Prod only (`npm audit --omit=dev`)        | 0        | 0    | 0        | 0   | 0    |

**Prod is 0/0/0/0** — clean, per the standing security-baseline rule. The 2 moderate advisories
are dev-only, both `qs` (GHSA-q8mj-m7cp-5q26, DoS on `qs.stringify`) via
`@lhci/cli > typed-rest-client > qs@6.11.1–6.15.1`, `fixAvailable: true`.

---

## Top 5 findings

1. **HIGH — Duplicate React instances (18.3.1 vs 19.2.7) reachable from the same Next.js bundle** in `apps/admin` and `apps/web` — root `node_modules/react@19.2.7` is pulled in by `@dnd-kit/*`, `@sentry/react`, `next-intl`, `next@16.2.9` itself (admin) and `@radix-ui/react-slot`, `framer-motion`, `lucide-react` (web), while each app has its own `node_modules/react@18.3.1`. Confirmed via `npm ls react --all` + physical `node_modules` paths.
2. **MEDIUM — `uuid` override is a bare `>=` (`">=11.1.1"`), drifted to v14.0.0**, contradicting the project's own documented "uuid held at v9, v14 is ESM-only, whole-build refactor" decision (`project-fwb-dep-upgrade-backlog.md`). Exactly the anti-pattern in `feedback-npm-override-major-pin-trap.md`. `package.json:114,119,126`.
3. **MEDIUM — `@lhci/cli` nested override doesn't reach the real vulnerable `qs`** — override targets `@lhci/cli > qs` but the CVE lives in `@lhci/cli > typed-rest-client > qs`, a level deeper than the override key path covers. Root cause of finding #Positive-audit-tally's 2 residual moderate advisories.
4. **MEDIUM — God files**: `apps/admin/src/app/stores/[id]/page-builder/page.tsx` (5,582 lines), `apps/api/src/services/product.service.ts` (2,027), 6 more files 1,400–1,700 lines.
5. **LOW — root `npm run typecheck` script is broken/misleading** vs. what CI actually runs — it sweeps `tests/` with different tsconfig aliases and fails with ~226 errors of noise; CI's real per-app `tsc -p apps/X/tsconfig.json` commands are all clean.

---

## 1. Vulnerabilities (`npm audit`)

### 1a. Full tree — 2 moderate, both dev-only

```
qs@6.11.1-6.15.1                     moderate  GHSA-q8mj-m7cp-5q26  fixAvailable
  via: @lhci/cli > typed-rest-client > qs
typed-rest-client (>=2.1.0)          moderate  via qs               fixAvailable
```

- `qs.stringify` DoS on null/undefined entries with `encodeValuesOnly` — CVSS 5.3.
- **Not a framework-downgrade trap** — the fix is a leaf bump of nested `qs`, not a major
  downgrade of anything load-bearing.
- **Root cause of why it's still open**: the root `package.json` override block already has
  an entry for exactly this —
  ```json
  "@lhci/cli": {
    "uuid": ">=11.1.1", "tmp": "0.2.7",
    "inquirer": ">=9.3.7", "external-editor": ">=3.1.0",
    "qs": ">=6.13.0", "typed-rest-client": ">=2.1.0"
  }
  ```
  but npm's nested-override key path only rewrites `@lhci/cli`'s **direct** `qs` dependency.
  The vulnerable copy lives one level deeper, at `@lhci/cli > typed-rest-client > qs`
  (confirmed: `node_modules/typed-rest-client/node_modules/qs`). The override never reaches it.
- **Fix**: nest one level deeper —
  `"@lhci/cli": { "typed-rest-client": { "qs": "^6.13.0" } }` (or a bare top-level
  `"qs": "^6.13.0"` override, since nothing in the prod path uses `qs` directly).
- **Severity in context**: dev-tooling only (`@lhci/cli` = Lighthouse CI), matches the
  already-documented "dev gated, unfixable transitive" exception in the CI/CD standard — but
  it IS fixable (see above), so it shouldn't be left as an accepted exception.
- CONFIRMED.

### 1b. Prod-only (`--omit=dev`) — 0/0/0/0

Clean. 885 prod dependencies, zero advisories at any severity.

---

## 2. Dependency hygiene

### 2a. Duplicate React instances — HIGH, CONFIRMED

`npm ls react --all` (after `npm ci`) shows, for `apps/admin`:

```
@force/admin@0.1.0
├─┬ @dnd-kit/core@6.3.1        → react@19.2.7 (deduped, ROOT copy)
├─┬ @dnd-kit/sortable@10.0.0   → react@19.2.7 (deduped, ROOT copy)
├─┬ @sentry/nextjs@10.58.0 → @sentry/react@10.58.0 → react@19.2.7 (deduped, ROOT copy)
├─┬ next-intl@4.13.0 → use-intl@4.13.0            → react@19.2.7 (deduped, ROOT copy)
├─┬ next@16.2.9 → styled-jsx@5.1.6                → react@19.2.7 (deduped, ROOT copy)
├── react-dom@18.3.1 → react@18.3.1  ← app's own nested copy
└── react@18.3.1
```

and for `apps/web`:

```
@force/web@0.1.0
├─┬ @radix-ui/react-slot@1.3.0 → react@19.2.7 (deduped, ROOT copy)
├─┬ framer-motion@12.40.0      → react@19.2.7 (deduped, ROOT copy)
├─┬ lucide-react@1.21.0        → react@19.2.7 (deduped, ROOT copy)
├── react-dom@18.3.1 → react@18.3.1  ← app's own nested copy
└── react@18.3.1
```

Physically confirmed two separate installations:

- `./node_modules/react/package.json` → `19.2.7` (root — where `@dnd-kit/core`,
  `@radix-ui/react-slot`, `framer-motion`, `lucide-react`, `@sentry/react`, `next-intl`,
  `next` all physically live, per `node_modules/<pkg>` lookups)
- `./apps/admin/node_modules/react/package.json` → `18.3.1`
- `./apps/web/node_modules/react/package.json` → `18.3.1`
- `./apps/orders/node_modules/react/package.json` → `18.3.1`
- `./packages/ui/node_modules/react/package.json` → `18.3.1`

None of the packages above declare a `react` requirement that excludes 18 (all peer ranges
are `^16.8 || ^17 || ^18 || ^19`-shaped) — nothing here _needs_ React 19. This is npm's
hoisting arbitrarily landing on 19 at the root with no direct root dependent, then failing
to dedupe because the app-level `react@^18.3.1` constraint can't be satisfied by the hoisted
copy. Node module resolution walks up from each package's own `node_modules` location, so:

- `@dnd-kit/core` (physically at `<root>/node_modules/@dnd-kit/core`) resolves `require('react')`
  to `<root>/node_modules/react@19.2.7`.
- The admin app's own components resolve `react` to `apps/admin/node_modules/react@18.3.1`.

Any Next.js/Turbopack bundle that pulls both an app component and one of the affected
libraries into the same chunk ships **two physical React module instances** — the classic
"Invalid hook call" / broken Context class of bug (React hooks and Context are tied to the
specific module instance's internal dispatcher). Concretely at risk: `@dnd-kit` drag-and-drop
in the admin page-builder, `next-intl`'s `IntlProvider`/`useTranslations` (used everywhere in
admin), `@sentry/react` error boundaries, `@radix-ui/react-slot`, `framer-motion` animations,
and `lucide-react` icons on the storefront.

This was **not caught by the existing `outputFileTracingRoot` workaround** in
`apps/admin/next.config.ts` (that fixes Vercel/Turbopack file-tracing for hoisted deps like
`react-onesignal`, a different problem from bundler-level module-instance duplication).

This is dependency-resolution-layer CONFIRMED; runtime symptom (actual "Invalid hook call")
was not reproduced with a live browser render in this audit — recommend a build+browser smoke
test on `apps/admin`'s page-builder (drag-and-drop) and any `@sentry/react` error-boundary path
as immediate follow-up.

**Fix**: add root-level `overrides` (or `pnpm.overrides`-equivalent) pinning
`"react": "18.3.1", "react-dom": "18.3.1"` for the whole workspace — no app here actually wants
React 19 (it's the explicitly held-back major per the dep-upgrade backlog), so a single pin
is safe and different from the horse-market case where two apps genuinely need different majors.

### 2b. `uuid` override — bare `>=`, drifted 5 majors — MEDIUM, CONFIRMED

```json
"uuid": ">=11.1.1",                                   // package.json:114
"exceljs": { "uuid": ">=11.1.1", "tmp": "0.2.7" },     // package.json:119 (nested)
"@lhci/cli": { "uuid": ">=11.1.1", ... }               // package.json:126 (nested)
```

Resolved version: **`uuid@14.0.0`** (`node_modules/uuid/package.json`). This is exactly the
anti-pattern in `feedback-npm-override-major-pin-trap.md`: a bare `>=` lets npm resolve to the
highest available major, dragging every consumer (here: `exceljs`, `@lhci/cli`) five majors
past whatever CVE the override was originally written to patch. It directly contradicts the
project's own documented decision (`project-fwb-dep-upgrade-backlog.md` item 11: "uuid 14.x —
ESM-only. Forces the API's CJS build to switch to ESM... Whole-build refactor" — held back
deliberately) — yet the override has silently forced exactly that major onto transitive
consumers.

**Currently not runtime-broken**: verified `require('uuid')` still resolves via uuid 14's
`exports["."]["node"]` condition (`dist-node/index.js`, a CJS-compatible build), so
`exceljs`'s `lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js` (`require('uuid')`) still loads
and a live `ExcelJS.Workbook().xlsx.writeBuffer()` smoke test succeeded. No direct app-source
import of `uuid` exists (`git grep` found none) — only transitive, via exceljs/@lhci/cli.
Risk is latent: a future uuid major could drop the `node` CJS-shim export condition, silently
breaking `exceljs` XLSX export (used for customer/order CSV/XLSX exports — a real feature, not
dev-only) with no CI signal until it ships.

**Fix**: pin to the specific patched major the CVE was originally targeting, e.g.
`"uuid": "^11.1.1"` (caret, not bare `>=`), everywhere the key appears.

### 2c. Outdated majors (`npm outdated -r`, 55 packages outdated, 13 major-version-behind)

| Package                                                       | Current          | Latest        | Note                                                                                                           |
| ------------------------------------------------------------- | ---------------- | ------------- | -------------------------------------------------------------------------------------------------------------- |
| `@tsparticles/engine` / `react` / `slim`                      | 3.9.1 / 3.0.0    | 4.3.1         | Already flagged deprecated by npm itself ("please update to 4.1.1") at install time                            |
| `otplib`                                                      | 12.0.1           | 13.4.1        | MFA/TOTP library (`apps/api/src/services/mfa.service.ts`) — security-adjacent, worth a deliberate upgrade pass |
| `resend`                                                      | 4.8.0            | 6.16.0        | Transactional email provider — 2 majors behind                                                                 |
| `rate-limit-redis`                                            | 4.3.1            | 5.0.0         |                                                                                                                |
| `express` / `@types/express`                                  | 4.22.2 / 4.17.25 | 5.2.1 / 5.0.6 | Already tracked + deliberately held in `project-fwb-dep-upgrade-backlog.md` — not new                          |
| `@commitlint/*`, `secretlint`, `@secretlint/*`, `lint-staged` | —                | —             | Dev tooling only                                                                                               |

All other previously-documented held-back majors (Prisma 7, TypeScript 6, ESLint 10,
`eslint-plugin-react-hooks` 7, React 19, `@types/node` 22+, Tailwind 4, `uuid` 14 as a _direct_
dep, `zod` 4) remain correctly pinned at their intentional versions — consistent with the
backlog memory, no drift on those (the `zod` version installed, `3.25.76`, is a single deduped
copy across every workspace — no dual-zod-version risk).

### 2d. License scan (`license-checker --production`)

```
MIT: 33, Apache-2.0: 9, BSD-3-Clause: 2, BSD-2-Clause: 1, 0BSD: 1, UNLICENSED: 1 (own package)
```

All permissive. No GPL/AGPL/copyleft in the production dependency tree. CLEAN.

### 2e. Zod/Prisma single-instance check

- `zod`: single deduped `3.25.76` across api/orders/shared/root — no dual-version risk.
- `PrismaClient`: one shared singleton in `packages/database/src/index.ts`; the only other
  `new PrismaClient()` call sites are one-off CLI scripts (`prisma/seed.ts`,
  `prisma/clone-demo-stores.ts`, `scripts/migrate-feature-flags.ts`, etc.) — the correct,
  expected pattern, not a duplicate-client bug.

---

## 3. Type-safety

### 3a. `tsc --noEmit`, matching CI's actual commands exactly

CI (`.github/workflows/ci.yml:127-139`) runs `npm run db:generate` → `npm run build -w
packages/database` → `tsc --noEmit -p apps/{api,admin,web,orders}/tsconfig.json` and
`-p packages/shared/tsconfig.json`. Reproduced exactly:

| Target                          | Result       |
| ------------------------------- | ------------ |
| `apps/api/tsconfig.json`        | **0 errors** |
| `apps/admin/tsconfig.json`      | **0 errors** |
| `apps/web/tsconfig.json`        | **0 errors** |
| `apps/orders/tsconfig.json`     | **0 errors** |
| `packages/shared/tsconfig.json` | **0 errors** |

**All CI-equivalent typechecks are clean.** POSITIVE.

### 3b. Root `npm run typecheck` script is broken vs. what CI actually runs — LOW, CONFIRMED

Root `package.json`'s own `"typecheck": "tsc --noEmit"` (invoking root `tsconfig.json`) is
**not** what CI runs and is currently broken if a developer runs it directly:

- Before `npm run db:generate` + `npm run build -w packages/database`: 1,097 errors, almost
  all `TS2307 Cannot find module '@force/database'` / `'@api/...'` phantom-error flood — this
  matches the documented CI/CD rule "Prisma db:generate BEFORE typecheck... without it tsc
  reports ~396 phantom errors" (here it's ~950, larger because the root config also sweeps
  `tests/`).
- Even _after_ building all packages, the root command still exits with 226 errors — the root
  `tsconfig.json` includes `tests/` (which reference path aliases like `@api/services/...`
  that only resolve inside each app's own tsconfig) plus stricter `noUnusedLocals`/
  `noUnusedParameters` than the per-app configs (which set `noUnusedLocals: false` for
  `apps/api`). These are almost entirely `TS6133` (unused var) and `TS2307` (path alias)
  noise, not real per-app type errors.

This is a real hygiene gap: the script a developer would naturally run (`npm run typecheck`)
does not reflect what CI actually gates on, and produces a wall of misleading errors. Low
severity because CI itself is unaffected (it never invokes the root script), but it erodes
trust in the "is my code green" signal locally.

**Fix**: either scope the root `tsconfig.json`'s `include`/settings to match what's
achievable standalone, add a `db:generate && build -w packages/database` prestep to the
`typecheck` npm script, or just remove the misleading root script and document
"typecheck per-app" as the supported flow (mirroring CI).

### 3c. `as any` / `@ts-ignore` / `@ts-expect-error` census

- `@ts-ignore`: **0** occurrences repo-wide.
- `@ts-expect-error`: **0** occurrences repo-wide.
- `as any`: 227 total occurrences; **the large majority are in `tests/*.test.ts`** (mocking
  boilerplate — acceptable, not a production type-safety issue). Non-test `as any` in
  `apps/*/src` and `packages/*/src`: ~50 occurrences, concentrated in:
  - **Express `Request` augmentation gaps** (LOW, CONFIRMED, easily fixable): the codebase
    _does_ properly extend `express-serve-static-core`'s `Request` interface in 3 places
    (`apps/api/src/types/express.d.ts` → `store`, `webhookSignature`; `middleware/auth.ts` →
    `user`; `middleware/store.ts` → `storeId`), but a few fields fall through that
    augmentation and get cast instead: `(req as any).tokenJti` (`middleware/auth.ts:114`),
    `(req as any).sessionId` (`routes/affiliate.routes.ts:475`), `(payload as any).purpose`
    (`middleware/auth.ts:81`, on the decoded JWT payload type). Fix: add `tokenJti?: string`
    to the `Request` augmentation and `purpose?: string` to the JWT payload type — removes 4
    casts with zero behavior change.
  - **Prisma JSON-column casts** (`shipping-carrier.service.ts`, `order.service.ts`,
    `expense-ocr.service.ts`, `abandoned-cart.service.ts`) — standard/expected pattern for
    Prisma `Json` columns (no stronger type exists without a runtime-validated schema on read);
    not flagged as a defect, just noted as the dominant non-test `as any` category.
  - **Inngest event-name casts** (`product.service.ts`, `product-meta-sync.ts`,
    `ai-autofill-*.ts`) — `as any` on event name/handler literals, a known Inngest SDK typing
    friction point, not a app-specific gap.
- Non-null assertions (`!`) directly on `req.body`/`req.params`/`req.query` in `apps/api/src`:
  **0** occurrences — CLEAN.

### 3d. Zod at API boundary

49 of 60 route files (`apps/api/src/routes/*.routes.ts`) import `zod`. The 11 without a zod
import:

- `webhook.routes.ts` — **reviewed, not a gap**: the `/payment` handler validates via
  provider-signature verification + an idempotency key derived from the raw payload
  (`checkIdempotency`), which is the correct control for heterogeneous external webhook
  payloads (MyFatoorah/Tap/Hesabe/UPayments) — Zod schema validation isn't the right tool here
  since the shape is provider-controlled and auto-detected.
- `alert-webhooks.routes.ts` — internal alerting webhooks (Sentry/Axiom/PostHog/Railway
  inbound), same class as above.
- `analytics.routes.ts`, `bot-analytics.routes.ts` — no `POST`/`PUT`/`PATCH` handlers found
  (read-only), lower risk.
- `locations.routes.ts`, `customers.routes.ts`, `wishlist.routes.ts`,
  `public-store-layout.routes.ts`, `upload.routes.ts`, `recommendation.routes.ts`,
  `routes/index.ts` (router registration, not a handler file) — **not individually verified
  line-by-line in this pass**; flagged PLAUSIBLE for follow-up, particularly
  `recommendation.routes.ts` (has `PUT`/`POST` handlers) and `upload.routes.ts` (file upload
  surface — worth confirming size/mimetype/field validation exists even if not via zod).

---

## 4. Code quality

### 4a. God files — MEDIUM, CONFIRMED

| File                                                                     | Lines |
| ------------------------------------------------------------------------ | ----- |
| `apps/admin/src/app/stores/[id]/page-builder/page.tsx`                   | 5,582 |
| `apps/api/src/services/product.service.ts`                               | 2,027 |
| `apps/api/src/routes/ai.routes.ts`                                       | 1,880 |
| `apps/api/src/routes/public.routes.ts`                                   | 1,703 |
| `apps/api/src/routes/store.routes.ts`                                    | 1,683 |
| `apps/api/src/routes/admin.routes.ts`                                    | 1,669 |
| `apps/api/src/routes/order.routes.ts`                                    | 1,664 |
| `apps/web/src/app/checkout/CheckoutClient.tsx`                           | 1,645 |
| `apps/admin/src/app/stores/[id]/shipping/_components/AreaRateEditor.tsx` | 1,552 |
| `apps/api/src/services/order.service.ts`                                 | 1,516 |
| `apps/admin/src/app/stores/[id]/seo/page.tsx`                            | 1,490 |
| `apps/api/src/routes/finance.routes.ts`                                  | 1,444 |

`page-builder/page.tsx` at 5,582 lines is the clearest single-file maintainability risk in the
repo — recommend splitting into per-block-type editor components (it's a page-builder, so a
natural seam already exists per block type). The route files (`ai`, `public`, `store`, `admin`,
`order`, `finance`) are large but the pattern (many independent Express handlers concatenated
in one file) is common for this codebase's style — lower urgency than the page-builder file.

### 4b. `console.log`/`console.debug` in production src (excluding tests)

Only 2 hits, both intentional OTEL boot-time diagnostics in `apps/api/src/tracing.ts:60,77`
(`[otel] tracing enabled...` / `[otel] OTEL_EXPORTER_OTLP_ENDPOINT not set...`). Not flagged as
a defect — this is one-time startup logging, not a per-request debug leftover, and the project
otherwise uses a structured `logger` elsewhere. LOW/informational only.

### 4c. TODO/FIXME/HACK on money/security paths

**0** occurrences in `apps/api/src/routes/*payment*`, `*order*`, or any file matching
`*payment*`/`*auth*` across `apps/api/src`. CLEAN.

### 4d. Dead code / orphaned exports

Not exhaustively swept in this pass (would need a dedicated unused-export tool run, e.g.
`ts-prune`, which isn't installed) — out of scope given the audit window; flagged as a gap in
this audit's own coverage, not a codebase finding.

---

## Ranked findings table

| #   | Severity | Status                           | Finding                                                                                                   | Location                                                                           |
| --- | -------- | -------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | High     | CONFIRMED (dep-resolution layer) | Duplicate React 18/19 instances reachable from admin + web bundles                                        | root `node_modules/react@19.2.7` vs `apps/{admin,web}/node_modules/react@18.3.1`   |
| 2   | Medium   | CONFIRMED                        | `uuid` override bare `>=`, drifted to v14 (contradicts documented hold)                                   | `package.json:114,119,126`                                                         |
| 3   | Medium   | CONFIRMED                        | `@lhci/cli` nested override misses actual vulnerable `qs` (2 moderate dev advisories open)                | `package.json:126`; `node_modules/typed-rest-client/node_modules/qs`               |
| 4   | Medium   | CONFIRMED                        | God file: page-builder at 5,582 lines                                                                     | `apps/admin/src/app/stores/[id]/page-builder/page.tsx`                             |
| 5   | Medium   | CONFIRMED                        | Outdated majors: `@tsparticles/*` (npm-flagged deprecated), `otplib` (MFA lib, 12→13), `resend` (4→6)     | `apps/web/package.json`, `apps/api/package.json`                                   |
| 6   | Low      | CONFIRMED                        | Root `npm run typecheck` script broken/misleading vs. CI's real per-app commands                          | `package.json` `scripts.typecheck`; root `tsconfig.json`                           |
| 7   | Low      | CONFIRMED                        | Express `Request`/JWT-payload typing gaps forcing 4 `as any` casts                                        | `middleware/auth.ts:81,114`, `routes/affiliate.routes.ts:475`                      |
| 8   | Low      | PLAUSIBLE                        | 8 route files missing zod import not individually re-verified (2 confirmed fine: webhook, alert-webhooks) | `locations/customers/wishlist/public-store-layout/upload/recommendation.routes.ts` |
| 9   | Low      | CONFIRMED (not a bug)            | Task-brief said "Fastify"; codebase is Express 4                                                          | `apps/api/src/routes/*`                                                            |
| —   | Positive | CONFIRMED                        | Prod `npm audit` 0/0/0/0                                                                                  | —                                                                                  |
| —   | Positive | CONFIRMED                        | All 5 CI-equivalent `tsc -p` targets clean (0 errors)                                                     | —                                                                                  |
| —   | Positive | CONFIRMED                        | Zero `@ts-ignore`/`@ts-expect-error` repo-wide; zero non-null `!` on `req.body/params/query`              | —                                                                                  |
| —   | Positive | CONFIRMED                        | License scan clean — 100% permissive (MIT/Apache/BSD/0BSD) in prod tree                                   | —                                                                                  |
| —   | Positive | CONFIRMED                        | Single deduped `zod@3.25.76` and single `PrismaClient` singleton pattern                                  | —                                                                                  |

---

## Commands run (raw summaries)

```
npm ci --prefer-offline --no-audit --no-fund        # 1,799 packages, 17s (node_modules was absent)
npm audit --json                                     # 2 moderate (qs/typed-rest-client), dev
npm audit --omit=dev --json                          # 0/0/0/0
npm outdated --json                                  # 55 outdated, 13 major-behind
npm run db:generate                                  # prisma generate — OK, offered 6.19.3→7.8.0 major (already tracked, held)
npm run build -w packages/database                   # OK
npm run build -w packages/shared                     # OK
npm run build -w packages/ui                         # OK
npx tsc --noEmit -p apps/api/tsconfig.json           # 0 errors
npx tsc --noEmit -p apps/admin/tsconfig.json         # 0 errors
npx tsc --noEmit -p apps/web/tsconfig.json           # 0 errors
npx tsc --noEmit -p apps/orders/tsconfig.json        # 0 errors
npx tsc --noEmit -p packages/shared/tsconfig.json    # 0 errors
npx tsc --noEmit  (root tsconfig.json)                # 226 errors — tests/ path-alias + stricter unused-var noise, not real bugs
npm ls react --all                                   # confirmed dual react@18.3.1 / react@19.2.7
npx license-checker --production --summary           # MIT 33, Apache-2.0 9, BSD-3 2, BSD-2 1, 0BSD 1, UNLICENSED 1
git grep -c "as any" / "@ts-ignore" / "@ts-expect-error"
find ... | xargs wc -l | sort -rn                    # god-file scan
```

Skipped (per instructions, "skip fixed"): everything already correctly pinned/held per
`project-fwb-dep-upgrade-backlog.md` (Express 5, Prisma 7, TypeScript 6, ESLint 10, React 19 as
a _direct_ dependency, Tailwind 4, uuid 14 as a _direct_ dependency, zod 4) — all still
correctly deferred, no new drift found on those beyond the transitive `uuid` override issue
above.
