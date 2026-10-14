## 4. Code Quality & Architecture Audit

### Executive Summary

FWB is a well-structured commercial SaaS monorepo with strong architectural intentions and a solid CI foundation. The main concerns are: (1) two live moderate vulnerabilities violating the project's own zero-tolerance policy, (2) severely under-exercised test suite (zero executed tests against the codebase, 30% threshold unreachable), (3) `strict: false` on the largest app (API at 206 files), and (4) 12 deliberately held-back major dep upgrades creating growing upgrade debt. Dead code, TODO count, and doc coverage are all clean. The service layer, error handling, and ESLint discipline are standout positives.

---

### Findings

#### 4.1 Monorepo Structure & Dep Boundaries

**Structure:** ✅ P2

```
apps/api      → Express API (206 .ts files)
apps/admin    → Next.js 16 admin (331 .ts/.tsx files, 86 pages)
apps/web      → Next.js 16 storefront (238 .ts/.tsx files, 37 pages)
packages/database → @ebda/database — Prisma client + bcryptjs
packages/shared   → @ebda/shared — Zod schemas + types
packages/ui       → @ebda/ui — React components (CVA, clsx, tailwind-merge)
packages/config   → @ebda/config — shared tooling config
```

**Dep graph (clean acyclic hierarchy):**

- `apps/api` → `@ebda/database`, `@ebda/shared`
- `apps/admin` → `@ebda/shared`, `@ebda/ui`
- `apps/web` → `@ebda/shared`, `@ebda/ui`
- `packages/ui` → React only
- `packages/shared` → Zod only
- `packages/database` → Prisma + bcryptjs

No circular deps. `@ebda/config` unused by any app — likely a stub. The boundary discipline is excellent: `apps/api` is the only consumer of `@ebda/database`, and frontends have no DB access path. 306 files in `apps/` import from `@ebda/*` correctly.

#### 4.2 Dependency Health (Audit, Outdated, Overrides)

**npm audit:** ❌ P1 — **2 moderate vulnerabilities** violating the zero-tolerance policy.

| Package           | Severity            | CVE                 | Issue                                   |
| ----------------- | ------------------- | ------------------- | --------------------------------------- |
| `uuid` < 11.1.1   | Moderate (CVSS 7.5) | GHSA-w5hq-g745-h8pq | Missing buffer bounds check in v3/v5/v6 |
| `exceljs` ≥ 3.5.0 | Moderate            | (via uuid)          | Pulls vulnerable uuid transitively      |

Fix is non-trivial: `uuid` pinned at `^9.0.1` (direct dep in `apps/api`), upgrade to v11 is CJS→ESM breaking change. **Proper fix:** migrate API's `uuid` call sites to `crypto.randomUUID()` (Node 16+ built-in, no dep needed). Then override `exceljs`'s nested uuid.

**Total dependencies:** 858 prod + 578 dev + 152 optional = **1,522 total**. Direct API deps: 32 — lean for scope.

**Outdated majors (12 held-back, all documented):**

| Package         | Current | Latest | Blocker                                       |
| --------------- | ------- | ------ | --------------------------------------------- |
| Express         | 4.22.2  | 5.2.1  | `params` type widening, 50+ sites             |
| Prisma          | 6.19.3  | 7.8.0  | `prisma.config.ts` migration                  |
| TypeScript      | 5.9.3   | 6.0.3  | Risk surface                                  |
| React/react-dom | 18.3.1  | 19.2.6 | Concurrent audit needed                       |
| Tailwind        | 3.4.19  | 4.3.0  | Config format rewrite                         |
| uuid            | 9.0.1   | 14.0.0 | ESM-only                                      |
| Zod             | 3.25.76 | 4.4.3  | Schema API breaks                             |
| resend          | 4.8.0   | 6.12.3 | No documented blocker — ⚠️ likely upgradeable |
| react-onesignal | 3.5.1   | 3.5.3  | Minor, likely safe                            |

**Overrides block:** All legit security/compatibility pins with documented rationale.

**License audit:** ✅ No AGPL/GPL. All MIT/Apache/ISC/BSD.

**Slop-squatting risk:** ✅ Low. All deps from known publishers.

#### 4.3 TypeScript Posture

**Mixed strictness — structural risk:** ⚠️ P2

| App          | strict       | noImplicitAny | strictNullChecks  |
| ------------ | ------------ | ------------- | ----------------- |
| `apps/api`   | `false`      | `false`       | (inherited false) |
| `apps/admin` | (base: true) | (base: true)  | `true`            |
| `apps/web`   | (base: true) | (base: true)  | `true`            |
| `packages/*` | `true`       | `true`        | `true`            |

Base `tsconfig.base.json` has strict baseline. `apps/api/tsconfig.json` explicitly overrides. API is largest single app (206 files) and most security-critical layer.

**Escape hatch counts:**

- `as any`: **27 instances** across **15 files** (mostly admin/web — response shape coercions)
- `@ts-ignore` / `@ts-expect-error`: **0 instances** in source

The `as any` pattern in admin pages suggests `ApiResponse<T>` wrapper isn't typed through fetch sites consistently.

#### 4.4 Test Coverage

**Severely underutilized:** ❌ P1

- Unit: **23 files** (`tests/unit/`)
- Integration: **27 files** (`tests/integration/` — heavy on accounting)
- E2E: **8 files** (`tests/e2e/`)
- **Total: 53 test files**

**Critical gap:** `find apps/ -name "*.test.ts"` returns **zero**. Admin (331 files) and web (238 files) have **zero test coverage**. Only API has coverage, and that's in shared root `tests/`.

**Coverage threshold:** 30% for lines/functions/branches/statements — described in comments as "initial gate" with intent to ratchet 5/quarter. Given zero frontend tests, actual coverage well below 30%.

**E2E writes to prod DB:** Documented in `project-fwb-test-stores-prod-db.md`. CI uses local test Postgres — correct. Risk is developer-run e2e locally + Vercel preview builds.

#### 4.5 Lint Discipline

**Strong setup, one gap:** ✅ P2

- **ESLint:** Flat config (`eslint.config.mjs`) across all 5 apps/packages. API config extends `tseslint.configs.recommended` with custom rules.
- **Custom Redis TTL floor rule:** `no-restricted-syntax` blocks cache TTLs <120s with allowlist mechanism — sophisticated.
- `@typescript-eslint/no-explicit-any`: set to `"warn"` (not `"error"`) — allows 27 `as any` instances through. Should be elevated.
- **Prettier:** Configured, enforced in CI.
- **Husky hooks:** `pre-commit` lint-staged. `pre-push` local DB backup on main pushes.
- **lint-staged:** secretlint + Prettier. **No ESLint in lint-staged** — lint errors don't block commits locally.
- **secretlint + TruffleHog + gitleaks:** All wired.

**Gap:** ESLint not in `lint-staged` — developer can commit code with lint errors that only surfaces in CI.

#### 4.6 Service Layer & Error Handling

**Excellent architecture:** ✅ P1

**Service layer:** 32,122 total lines. Clear service-per-domain pattern, no business logic leaking into routes. Key services: `product.service.ts` (1,341 lines), `order.service.ts` (1,259 lines), `auth.service.ts` (996 lines), `email.service.ts` (924 lines), `loyalty.service.ts` (914 lines), `payment.factory.ts` (1,105 lines). Large but domain-coherent.

**Error handling (`apps/api/src/middleware/error-handler.ts`):** Well-designed. `AppError` class, typed status codes. Log level discrimination: 4xx → `debug`, 5xx → `error`, ZodError → `debug`, Prisma known → `error`. Correct production pattern.

**Inngest (30 functions):** Accounting (11), bulk AI (4), analytics, order lifecycle, stock, audit/retention, alerts.

**Auth middleware chain:** Documented and enforced. `requireRole()` deprecated in favor of `authorize()`.

**Pino structured logging:** ✅ Used project-wide.

#### 4.7 Dead Code & TODOs

**Very clean:** ✅ P3

**TODOs/FIXMEs:** grep for `// TODO`, `// FIXME`, `// HACK` returns **zero results**. Unusually clean.

**Dead code signals:**

- `NotificationContext` sets up WebSocket but no pages call `subscribeToStore()` — wired but inactive
- `@ebda/config` package exists but no app `package.json` lists it as dependency
- Stale Vercel projects (`force-web-sigma`, `force-web-sigma-seven`) flagged for deletion

**`__dangerously_set_inner_HTML__` usage** (8 instances, all safe — JSON-LD via stringify, CmsPageContent uses HTML escape, admin content renders use URL validator for link protocols).

#### 4.8 Tech Debt Inventory

**Well-documented, appropriately deferred:** ⚠️ P2

**12 held-back major dep upgrades** (per `project-fwb-dep-upgrade-backlog.md`):

- 7 blocked by legitimate technical chains
- `uuid` now blocked by active vulnerability (P1)
- `resend@4.8.0` vs `6.12.3` — no documented blocker, should be investigated

**From CLAUDE.md Known Issues:** Cart sync N-calls pattern (still present), profile fetched independently in `SettingsClient`, `isPlatform` detection duplicated (3 sites — low risk).

**API TypeScript strictness debt:** Pragmatic but growing surface area. 206 files now; enable-strict cost rises.

#### 4.9 Doc Coverage

**Strong documentation posture:** ✅ P2

| Artifact                 | Status                        |
| ------------------------ | ----------------------------- |
| Root `README.md`         | ✅ Present                    |
| Root `design.md`         | ✅ Present                    |
| Root `CLAUDE.md`         | ✅ Comprehensive (408+ lines) |
| `docs/ROLLBACK.md`       | ✅ Present                    |
| `docs/INCIDENT.md`       | ✅ Present                    |
| `docs/RETENTION.md`      | ✅ Present                    |
| Per-app `README.md`      | ❌ Not found                  |
| `apps/api/CLAUDE.md`     | ❌ Not present                |
| TSDoc on service methods | ⚠️ Sparse                     |

Root CLAUDE.md is unusually thorough — compensates for lack of per-app READMEs.

#### 4.10 Graph Signals (God Nodes, Bridges)

**Graph:** 8,082 nodes · 17,228 edges · 525 communities. Well-structured for 1,041 files.

**God nodes (high fan-out):**

| Node              | Edges | Interpretation                                                    |
| ----------------- | ----- | ----------------------------------------------------------------- |
| `useLanguage()`   | 278   | Every UI component is i18n-aware. Change risk very high           |
| `useStore()`      | 114   | Good SSoT — but any StoreContext shape change = 114-site refactor |
| `AdminLayout()`   | 112   | All 86 admin pages share one layout                               |
| `apiGet()`        | 111   | All admin data fetches use one function                           |
| `LanguageContext` | 73    | Tight coupling to i18n throughout storefront                      |
| `EmailService`    | 66    | Many services depend on email                                     |

`useLanguage()` at 278 edges is highest-risk node. Inherent to bilingual-first design, not a defect — argues for keeping LanguageContext API surface minimal and stable.

---

### Code-Quality Scorecard

| Aspect             | Grade | Notes                                                                                |
| ------------------ | ----- | ------------------------------------------------------------------------------------ |
| Type safety        | C     | API runs strict:false; 27 `as any` escapes                                           |
| Test coverage      | D     | 53 test files; zero frontend tests                                                   |
| Dependency health  | C+    | 2 active moderate CVEs (uuid); 12 held-back majors                                   |
| Lint discipline    | B+    | Flat ESLint, custom Redis rule, secretlint, husky — `no-explicit-any` warn not error |
| Service layer      | A-    | Clean service-per-domain, correct middleware chain                                   |
| Error handling     | A     | Discriminated log levels, AppError class, pino structured logs                       |
| Documentation      | B+    | Exceptional CLAUDE.md + ops docs; no per-app READMEs; sparse TSDoc                   |
| Dead code / TODOs  | A     | Zero TODO comments in source                                                         |
| Monorepo structure | A     | Clean dep boundaries, correct build order                                            |
| Async/queue design | A-    | 30 Inngest functions, retries configured, quota caps                                 |

---

### Top 5 P0/P1 Code-Quality Risks

**P1-1: Active CVEs violate zero-tolerance policy**
`uuid@9.0.1` (CVSS 7.5) + `exceljs` transitive. CI's `npm audit --audit-level=low` will fail. **Fix:** migrate `uuid` call sites in `apps/api/src/` to `crypto.randomUUID()` (Node 16+ built-in). Then override `exceljs`'s nested uuid. ~2 hours.

**P1-2: Zero frontend test coverage**
Admin (86 pages, 331 files) and storefront (37 pages, 238 files) have no tests. Any regression in checkout, auth, cart, or admin CRUD goes undetected until production. **Fix:** smoke tests for `/stores/[id]/products`, cart add/remove, auth redirect, checkout via Playwright or Vitest+jsdom.

**P1-3: `apps/api` running strict:false**
Most security-critical layer (206 files, all payment/auth/order logic) has `strict: false, noImplicitAny: false`. Type system offers no safety net. **Fix:** one-time strict-mode refactor pass.

**P2-4: `as any` coercions masking ApiResponse type drift**
17 of 27 `as any` instances coerce API response shapes. Symptom of `ApiResponse<T>` wrapper not propagated through fetch sites. **Fix:** typed `extractData<T>()` helper + custom ESLint rule.

**P2-5: ESLint `no-explicit-any` is warn, not error; not in lint-staged**
27 `as any` escapes pass CI without blocking. **Fix:** elevate to `"error"` + add `eslint --fix` to lint-staged.
