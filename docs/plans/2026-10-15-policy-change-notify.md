# Policy Change Notify Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the published sentence true: "We may update this policy and will post the new version here with its date; we will notify merchants of material changes." A material policy change shows a non-blocking notice in every merchant's dashboard AND emails every store owner once. Acceptance is recorded at signup (click-wrap) and when a notice is acknowledged.

**Architecture:** One versioned registry, `LEGAL_POLICIES` in `packages/shared/src/legal/`, is the only source of version, dates, `material`/`feeChange` flags and the change summary. The policy text stays in `apps/marketing/src/lib/legal-{ar,en}.ts`, and the marketing pages render their "last updated" line from the registry. Three new Prisma models record what happened: `LegalAcceptance` (user-keyed, append-only), `LegalNoticeSend` (platform-global, one row per announced version) and `LegalNoticeDelivery` (user-keyed, one row per recipient per version, the idempotency ledger for the email fan-out). A super-admin "Send notice" writes the `LegalNoticeSend` row and emits `legal/notice.send-requested`. The `legal-notice-send` Inngest function claims each delivery row `queued → sending` before it mails, so a retry cannot mail anyone twice. The admin banner reads `GET /me/legal-notices`, which is computed live and never cached.

**Tech Stack:** TypeScript, Zod 3, Prisma 6.19 (`@prisma/adapter-pg`, strict RLS as `ebda_app`, code-level tenant guard), Express on Cloudflare Workers, Inngest, platform mailer (Resend in production, captured outbox elsewhere), Next.js 16 admin (next-intl), Next.js static marketing export, Vitest 4 (jsdom for components, supertest + real Postgres for integration).

**Spec:** this file, section "Decisions (binding)" just below. It records Ahmad's 2026-10-15 instruction and the coordinator's decisions verbatim in substance; the executor reads it as the spec.

### Decisions (binding)

1. **Versions in code.** `LEGAL_POLICIES` in `packages/shared` holds, per doc key (`legal`, `privacy`, `terms`, `acceptableUse`, `merchant`), a `history` array of `{version, publishedAt, effectiveAt, material, feeChange, summary:{ar,en}}`, oldest first. The current version is the last entry. Publishing a change is a code change that edits the text AND appends the entry in the same PR. Marketing pages render date and version from it; the hard-coded `updated.date` / `updated.version` strings are removed (the label text stays). A unit test enforces: every doc key has an entry, each version is strictly newer than the previous one, `feeChange` implies `effectiveAt >= publishedAt + 30 days`.
2. **Recording.** New models plus an additive migration: `LegalAcceptance` (userId, docKey, version, acceptedAt, ip, userAgent, source `signup|notice_ack`, unique (userId, docKey, version)); `LegalNoticeSend` (docKey, version, sentAt, sentBy, recipientCount, unique (docKey, version)); `LegalNoticeDelivery` (userId, docKey, version, status, error, createdAt, unique (userId, docKey, version)). They follow the repo's conventions for non-store tables: user-keyed RLS for the two user tables, a documented global exception for `legal_notice_sends`, the tenant-guard classification, and a regenerated snapshot. The migration has no `lock_timeout`.
3. **Signup click-wrap.** A required checkbox, "أوافق على الشروط وسياسة الخصوصية واتفاقية التاجر وسياسة الاستخدام المقبول", with links. The API schema requires `acceptedLegal: true`. The API writes `LegalAcceptance` rows for the CURRENT version of all 5 docs (source `signup`, ip/ua) in the same transaction as the new user's profile write, and rejects anything else.
4. **Notice (non-blocking).** The banner appears when a material version has been SENT (a `LegalNoticeSend` row exists) and the logged-in merchant has no `LegalAcceptance` for that docKey+version. It shows on every store page next to `BillingStatusBanner` and contains the summary, effective date, a link to the policy on ebda.app and a "تمام، فهمت" / "Got it" button that records `notice_ack`. Several pending notices share one banner and one ack. It never blocks the admin. API: `GET /me/legal-notices`, `POST /me/legal-notices/ack {items:[{docKey,version}]}`. The ack validates that every item is a pending current material version.
5. **Email.** A super-admin page "Policy updates" lists each doc's current version and shows a "Send notice" button for a material version that has no `LegalNoticeSend`. The button asks for confirmation in the page (no `window.confirm`). The API (super_admin only) creates the send row and emits an Inngest event. The fan-out sends one bilingual transactional email per OWNER of a non-deleted store, deduped per user and throttled, in the user's language (fallback ar). It goes through the platform mailer, is idempotent via the delivery row, marks failures `failed` (fail-fast), and has no unsubscribe link (documented). A second send for the same version answers 409.
6. **Docs.** ENVIRONMENT (only the existing pacer variable gains a sentence), `Ruling LEGAL-4` (+ residuals as `LEGAL-5`) in `docs/RULINGS.md`, the merchant FAQ, and a "how to publish a policy change" runbook.
7. **Never-stale reads.** The pending-notice read is not cached anywhere (`Cache-Control: no-store`, no Redis/KV/bounded-map). Ack and send therefore need no invalidation.

## Coordinator amendments (binding; override the task text where they conflict)

- **A1 — one bilingual email, Arabic first.** Legacy accounts carry the column default `users.language = 'en'`, so the stored language cannot be trusted for a legal notice. Task 7 sends ONE email per user containing the full Arabic block (`dir="rtl"`) followed by the full English block, with a bilingual subject (`تحديث في سياسات إبدأ · Ebda policy update`). Drop the `language` parameter from `sendLegalNoticeEmail` and the `user.language` read in the fan-out; tests assert both blocks are present and Arabic comes first. LEGAL-5(d) is replaced by: "the notice email is bilingual (Arabic first) for every recipient (Ruling LEGAL-6)". Add `Ruling LEGAL-6 — legal notice emails are bilingual, Arabic first, regardless of users.language (legacy default 'en' makes the stored value unreliable). Cost if wrong: a longer email.`
- **A2 (T3)** — the "contextless sees none" subtest runs on an UNGUARDED ebda_app client (as `rls-ebda-app.test.ts` does); RLS is what it proves, not the code guard.
- **A3 (T2)** — `apps/marketing/src/lib/content.ts` `footer.legalVersion` (ar + en, ~:635 / ~:1024) renders from `LEGAL_POLICIES` (no hard-coded version/date) and is covered by the copy-literal/date test; that test must fail before the change.
- **A4 (T7)** — wait for the send slot WITH a time budget BEFORE claiming a row `queued→sending`; no slot → end the step and continue in a later step (as campaign-send does); adjust `maxBatches`/`BATCH_CAP_REACHED` to match. Add unit tests for `onFailure` and the fail-leftover path (pattern: `campaign-send-job.test.ts`).
- **A5 (T5)** — mount `rejectImpersonated` after `authenticate` on `POST /me/legal-notices/ack` (and GET), with a test that an impersonating super admin gets refused.
- **A6 (T5)** — ack accepts only items that are SENT, MATERIAL and CURRENT; an already-acked such item is a 200 no-op; anything else (incl. `privacy@1.0` from signup) is 422 `NOT_PENDING`. Test with a fixture user that HAS signup rows.
- **A7 (T7)** — apply A1 everywhere: no `language` param on `sendLegalNoticeEmail`; `LegalNoticeEmailData` carries ar AND en values; one Arabic-then-English body; no `language` in the fan-out user select; tests assert both blocks present, Arabic first (replace the English-subject and "language honoured" asserts).
- **A8 (T7)** — subject built from `BRAND.product.nameAr` / `BRAND.product.nameEn`, never typed by hand. Shell `renderBrandedShell({ defaultLanguage: 'ar' })`; the English block carries `dir="ltr"`.
- **A9 (T9 + Decision 5 + Global Constraints line about language)** — read them as A1: LEGAL-4(4) says bilingual Arabic-first, LEGAL-5(d) replaced, LEGAL-6 added; commit message mentions legal-4/5/6.
- **A10 (T3)** — plain DDL (no IF NOT EXISTS) matches repo convention (B0 size_charts); record that in the migration header comment.
- **A11 (T8)** — every data needs a UI: the Policy updates page lists failed deliveries per version (masked email + error + time). No SQL-only runbook step.
- **A12 (T9 Step 6)** — the live probe posts a FULL signup body with `acceptedLegal:false` and the honeypot filled: deployed → 400 `VALIDATION_ERROR`; not deployed → generic 200 and no account. Never create a real account.
- **A13 (T9)** — LEGAL-4/5/6 go next to LEGAL-1..3 in `docs/RULINGS.md` (≈ line 5718), not under the B0 heading.
- **A14 (T4/T5/T8 tests)** — T4 runs `admin-i18n-keys-resolve.test.ts`; T4 adds a test for the acceptance write on the unverified-resend path; T8 re-runs the signup unit tests after `legal-notice.service.ts` imports the Inngest client.
- **A15 (T4/T5)** — one shared helper builds an acceptance row (UA truncation + shape); both signup and ack use it.
- **A16 (minor)** — no unused `_drop` (lint clean); the T2 date test must fail first; T3's expected failure is a runtime TypeError; line refs are approximate — find by symbol.
- **A17 (env)** — run `npm ci` (npm 10) in the worktree before Task 1; build `packages/shared` and `packages/database` and `db:generate` as the repo requires.

## Global Constraints

- Arabic-first: every merchant-facing string ships in `ar` and `en`; the email and banner pick the reader's language, fallback `ar`.
- NUMERALS-1: Latin digits everywhere in the admin and in emails. Dates go through `formatLegalDate()` (pins `-u-nu-latn` and `timeZone: 'UTC'`), counts go into i18n params as `String(n)`.
- Brand strings, domains and sender addresses come from `BRAND` (`packages/shared/src/brand/`), never typed.
- No new environment variables. The fan-out reuses `awaitCampaignSendSlot()` (`CAMPAIGN_PLATFORM_SEND_INTERVAL_MS`) so the shared Resend budget stays bounded.
- Migrations: additive only, every statement idempotent where Prisma allows, NO `lock_timeout` (docs/DB-INDEX-MIGRATIONS.md). The new tables are empty, so plain `CREATE INDEX` is correct.
- RLS/tenant guard: no `withRlsBypass`/`withOwnerTx` in `apps/api/src`; `asPlatformOperator` only in the new service file, added to the allow-list in `tests/unit/no-rls-bypass-in-runtime.test.ts`.
- Route authorization: super-admin routes = `authenticate → requireMfaEnrolled → authorize('super_admin')`; merchant routes = `authenticate → authorize(...)`.
- commitlint: all-lowercase subjects, blank line before trailers. `git add` named paths only, never `-A`/`.`.
- Admin copy only through `useT` (guarded by `tests/unit/admin-i18n-*.test.ts`); en/ar key parity.
- Integration tests are retry-safe: every fixture id/email is per-call unique, and rows keyed on a fixed `(docKey, version)` are deleted in `beforeEach` and `afterAll`.

## Review Focus

1. **A merchant who owns two stores** gets exactly ONE email for a version (recipients are deduped by user, and the delivery row is unique per user+version), and ONE "Got it" removes the banner on both stores, because pending notices are per user and not per store. Pinned by `tests/integration/legal-notice-fanout.test.ts` ("two stores, one email") and `tests/integration/legal-notices.test.ts` ("one ack clears it for every store").
2. **An Inngest retry after a partial fan-out** (a step re-run, or a whole re-run with a fresh memo) never mails anyone twice: a row leaves `queued` before the send, and a row left in `sending` by a crash is never re-sent. Pinned by the "re-run sends nothing new" and "a row stuck in sending is never re-sent" cases in `legal-notice-fanout.test.ts`.
3. **Signup without the checkbox** is refused by the API even if the UI is bypassed: missing or `false` `acceptedLegal` gives 400 `VALIDATION_ERROR` and creates no user. Pinned by `tests/integration/legal-signup-acceptance.test.ts`.
4. **An ack for a version that is not pending** (an old version, a non-material version, a never-sent version, an unknown doc key) is refused with 422 `NOT_PENDING` and writes nothing. A repeated ack of an already-acknowledged item is a harmless 200. Pinned by `legal-notices.test.ts`.
5. **The marketing "last updated" line** equals the registry's `publishedAt`/`version` for each page in both `ar` and `en`, and the copy files contain no date or version literal any more. Pinned by `tests/unit/marketing-site.test.tsx`.
6. **A double click on "Send notice"** (or a second operator) gives 409 `ALREADY_SENT` and emits no second event. If the Inngest enqueue fails, the send row is removed and the call answers 502, so nothing is left half-announced. Pinned by `tests/integration/legal-policy-admin.test.ts`.

## Finish line

- **Must work:** the marketing date/version comes from the registry; signup requires and records acceptance; a sent material version shows one banner per merchant until "Got it"; "Send notice" mails each store owner once; a second send is refused.
- **Exercised:** `POST /api/v1/auth/merchant/signup`, `GET /api/v1/me/legal-notices`, `POST /api/v1/me/legal-notices/ack`, `GET /api/v1/admin/legal-policies`, `POST /api/v1/admin/legal-policies/:docKey/:version/send-notice`, the `legal-notice-send` handler, `/signup`, `/stores/[id]/*` (banner), `/policy-updates`, the built `out/terms/index.html` + `out/en/terms/index.html`.
- **Must NOT change:** the policy text (no version bump ships with this plan; v1.0 stays non-material, so no banner and no email fire on deploy), existing RLS policies, the order-email queue, signup abuse controls.
- **Done =** every task's test command passes; `npm run typecheck` and `npm run lint` exit 0; `npm run gen:tenant-guard-schema -w packages/database -- --check` exits 0; the blast-radius sweep in Task 9 is stated with its result; after deploy, the live checks in Task 9 Step 6 are reported, including what could not be verified.

## File structure

| File                                                                                                                                                    | Responsibility                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `packages/shared/src/legal/index.ts` (new)                                                                                                              | Registry, types, validation, pending computation, URL/date helpers. Pure; imports only `../brand`. |
| `packages/shared/src/__tests__/legal-policies.test.ts` (new)                                                                                            | Registry invariants + helpers.                                                                     |
| `apps/marketing/src/components/LegalPage.tsx`, `lib/legal-{types,en,ar}.ts`                                                                             | Render date/version from the registry.                                                             |
| `packages/database/prisma/schema.prisma`, `migrations/20261017000100_legal_acceptances_and_notices/`                                                    | Models, tables, RLS.                                                                               |
| `packages/database/src/tenant-guard.ts` (+ generated snapshot)                                                                                          | Classify the 3 models.                                                                             |
| `apps/api/src/services/legal-notice.service.ts` (new)                                                                                                   | Signup rows, pending/ack, recipients, fan-out batches, send request, overview.                     |
| `apps/api/src/routes/legal-policy.routes.ts` (new)                                                                                                      | `meLegalNoticeRoutes` + `adminLegalPolicyRoutes`.                                                  |
| `apps/api/src/services/email-templates/legal-notice.ts` (new), `platform-mailer.ts`                                                                     | The email.                                                                                         |
| `apps/api/src/lib/inngest/functions/legal-notice-send.ts` (new)                                                                                         | The fan-out function.                                                                              |
| `apps/admin/src/components/legal/LegalNoticeBanner.tsx` (new)                                                                                           | The banner.                                                                                        |
| `apps/admin/src/app/policy-updates/page.tsx` (new)                                                                                                      | Super-admin page.                                                                                  |
| `apps/admin/src/app/signup/page.tsx`                                                                                                                    | Click-wrap.                                                                                        |
| `docs/runbooks/legal-policy-change.md` (new), `docs/RULINGS.md`, `docs/merchant/faq.md`, `docs/runbooks/SUPER-ADMIN-PLAYBOOK.md`, `docs/ENVIRONMENT.md` | Docs.                                                                                              |

### Test environment (used by every integration step)

```bash
# A local Postgres 16 with the CI database name; migrate it and give ebda_app a login (CI does the same).
export DATABASE_URL=postgresql://test:${TEST_DB_PASSWORD}@localhost:5432/force_test
export DIRECT_URL=$DATABASE_URL
export NODE_ENV=test
npx prisma migrate deploy --schema packages/database/prisma/schema.prisma
psql "$DATABASE_URL" -c "ALTER ROLE ebda_app LOGIN PASSWORD 'ci-only-app-pw'"
```

---

### Task 1: Versioned legal policy registry in `@ebda/shared`

**Files:**

- Create: `packages/shared/src/legal/index.ts`
- Create: `packages/shared/src/__tests__/legal-policies.test.ts`
- Modify: `packages/shared/src/index.ts` (add the export next to `export * from './setup-guide';`, line 33)
- Modify: `packages/shared/package.json` (`exports`, add `./legal` after `./brand`)
- Modify: `vitest.shared.ts` (`workspaceAliases`, add the `@ebda/shared/legal` alias)

**Interfaces:**

- Consumes: `BRAND.domains.marketing` from `packages/shared/src/brand`.
- Produces (exact names, used by Tasks 2, 4, 5, 6, 7, 8):
  - `LEGAL_DOC_KEYS: readonly ['legal','privacy','terms','acceptableUse','merchant']`, `type LegalDocKey`
  - `interface LegalVersion { version; publishedAt; effectiveAt; material; feeChange; summary: {ar; en} }`
  - `type LegalPolicies = Readonly<Record<LegalDocKey, { readonly history: readonly LegalVersion[] }>>`
  - `LEGAL_POLICIES: LegalPolicies`, `LEGAL_FEE_NOTICE_DAYS = 30`
  - `LEGAL_DOC_TITLE: Record<LegalDocKey, {ar; en}>`, `LEGAL_DOC_SLUG: Record<LegalDocKey, string>`
  - `isLegalDocKey(x: unknown): x is LegalDocKey`
  - `currentLegalVersion(policies: LegalPolicies, key: LegalDocKey): LegalVersion`
  - `findLegalVersion(policies: LegalPolicies, key: string, version: string): LegalVersion | null`
  - `compareLegalVersions(a: string, b: string): number`
  - `validateLegalPolicies(policies: Record<string, { history: readonly LegalVersion[] }>): string[]`
  - `legalPolicyUrl(key: LegalDocKey, lang: 'ar' | 'en'): string`
  - `formatLegalDate(isoDate: string, lang: 'ar' | 'en'): string`
  - `interface LegalDocRef { docKey: string; version: string }`
  - `interface PendingLegalNotice { docKey: LegalDocKey; version: string; effectiveAt: string; summary: {ar; en}; title: {ar; en}; url: {ar; en} }`
  - `computePendingNotices(policies: LegalPolicies, sent: readonly LegalDocRef[], accepted: readonly LegalDocRef[]): PendingLegalNotice[]`

- [ ] **Step 1: Write the failing test**

`packages/shared/src/__tests__/legal-policies.test.ts`:

```ts
/**
 * Ruling LEGAL-4: the legal-policy registry is the single source of each document's version,
 * dates and material/fee flags. These invariants are what make "we will notify merchants of
 * material changes" and the Terms' 30-day fee-change promise checkable at PR time.
 */
import { describe, it, expect } from 'vitest';
import {
  LEGAL_DOC_KEYS,
  LEGAL_POLICIES,
  LEGAL_DOC_SLUG,
  compareLegalVersions,
  computePendingNotices,
  currentLegalVersion,
  findLegalVersion,
  formatLegalDate,
  legalPolicyUrl,
  validateLegalPolicies,
  type LegalPolicies,
  type LegalVersion,
} from '../legal';

const v = (over: Partial<LegalVersion> = {}): LegalVersion => ({
  version: '1.0',
  publishedAt: '2026-10-07',
  effectiveAt: '2026-10-07',
  material: false,
  feeChange: false,
  summary: { ar: 'الإصدار الأول.', en: 'First version.' },
  ...over,
});
const withTerms = (history: LegalVersion[]): LegalPolicies => ({
  ...LEGAL_POLICIES,
  terms: { history },
});

describe('LEGAL_POLICIES (the shipped registry)', () => {
  it('passes every invariant', () => {
    expect(validateLegalPolicies(LEGAL_POLICIES)).toEqual([]);
  });
  it('has an entry for every document key and nothing else', () => {
    expect(Object.keys(LEGAL_POLICIES).sort()).toEqual([...LEGAL_DOC_KEYS].sort());
    for (const k of LEGAL_DOC_KEYS) expect(LEGAL_POLICIES[k].history.length).toBeGreaterThan(0);
  });
});

describe('validateLegalPolicies', () => {
  it('flags a missing document', () => {
    const { privacy: _drop, ...rest } = LEGAL_POLICIES;
    expect(validateLegalPolicies(rest)).toContain('privacy: no entry');
  });
  it('flags an unknown document key', () => {
    expect(validateLegalPolicies({ ...LEGAL_POLICIES, cookies: { history: [v()] } })).toContain(
      'cookies: unknown document'
    );
  });
  it('flags a version that is not newer than the previous one', () => {
    const errors = validateLegalPolicies(withTerms([v(), v({ version: '1.0' })]));
    expect(errors).toContain('terms@1.0: not newer than 1.0');
  });
  it('orders versions numerically (1.10 is newer than 1.9)', () => {
    expect(compareLegalVersions('1.10', '1.9')).toBeGreaterThan(0);
    expect(
      validateLegalPolicies(
        withTerms([v({ version: '1.9' }), v({ version: '1.10', publishedAt: '2026-10-08' })])
      )
    ).toEqual([]);
  });
  it('flags a version published before the previous one', () => {
    const errors = validateLegalPolicies(
      withTerms([v(), v({ version: '1.1', publishedAt: '2026-10-01', effectiveAt: '2026-10-01' })])
    );
    expect(errors).toContain('terms@1.1: published before 1.0');
  });
  it("refuses a fee change with less than 30 days' notice, accepts exactly 30", () => {
    const fee = (effectiveAt: string) =>
      v({
        version: '1.1',
        publishedAt: '2026-11-01',
        effectiveAt,
        material: true,
        feeChange: true,
      });
    expect(validateLegalPolicies(withTerms([v(), fee('2026-11-30')]))).toContain(
      "terms@1.1: a fee change needs 30 days' notice"
    );
    expect(validateLegalPolicies(withTerms([v(), fee('2026-12-01')]))).toEqual([]);
  });
  it('refuses a fee change that is not marked material', () => {
    const errors = validateLegalPolicies(
      withTerms([
        v(),
        v({
          version: '1.1',
          publishedAt: '2026-11-01',
          effectiveAt: '2026-12-01',
          feeChange: true,
        }),
      ])
    );
    expect(errors).toContain('terms@1.1: a fee change is always material');
  });
  it('refuses an effective date before the publish date, bad dates and an empty summary', () => {
    const errors = validateLegalPolicies(
      withTerms([
        v({ effectiveAt: '2026-10-06' }),
        v({ version: '1.1', publishedAt: '7 Oct 2026' }),
        v({ version: '1.2', publishedAt: '2026-10-09', summary: { ar: '', en: 'x' } }),
      ])
    );
    expect(errors).toContain('terms@1.0: effectiveAt before publishedAt');
    expect(errors).toContain('terms@1.1: dates must be YYYY-MM-DD');
    expect(errors).toContain('terms@1.2: summary needs ar and en');
  });
});

describe('helpers', () => {
  it('current = last history entry; find by version', () => {
    const p = withTerms([v(), v({ version: '1.1', publishedAt: '2026-10-09' })]);
    expect(currentLegalVersion(p, 'terms').version).toBe('1.1');
    expect(findLegalVersion(p, 'terms', '1.0')?.version).toBe('1.0');
    expect(findLegalVersion(p, 'terms', '9.9')).toBeNull();
    expect(findLegalVersion(p, 'cookies', '1.0')).toBeNull();
  });
  it('formats the date like the published pages, Latin digits, no timezone drift', () => {
    expect(formatLegalDate('2026-10-07', 'en')).toBe('7 October 2026');
    expect(formatLegalDate('2026-10-07', 'ar')).toBe('7 أكتوبر 2026');
    expect(formatLegalDate('2026-10-07', 'ar')).not.toMatch(/[٠-٩]/);
  });
  it('links to the marketing page of each document, per locale', () => {
    expect(legalPolicyUrl('terms', 'ar')).toBe('https://ebda.app/terms/');
    expect(legalPolicyUrl('merchant', 'en')).toBe('https://ebda.app/en/merchant-agreement/');
    expect(LEGAL_DOC_SLUG.acceptableUse).toBe('acceptable-use');
  });
});

describe('computePendingNotices', () => {
  const material = v({
    version: '1.1',
    publishedAt: '2026-11-01',
    effectiveAt: '2026-12-01',
    material: true,
    feeChange: true,
    summary: { ar: 'تغيير في الرسوم.', en: 'Fee change.' },
  });
  const p = withTerms([v(), material]);

  it('nothing is pending until the current material version has been SENT', () => {
    expect(computePendingNotices(p, [], [])).toEqual([]);
  });
  it('a sent, unaccepted current material version is pending, with title and links', () => {
    const out = computePendingNotices(p, [{ docKey: 'terms', version: '1.1' }], []);
    expect(out).toEqual([
      {
        docKey: 'terms',
        version: '1.1',
        effectiveAt: '2026-12-01',
        summary: { ar: 'تغيير في الرسوم.', en: 'Fee change.' },
        title: { ar: 'شروط الخدمة', en: 'Terms of service' },
        url: { ar: 'https://ebda.app/terms/', en: 'https://ebda.app/en/terms/' },
      },
    ]);
  });
  it('an accepted version is not pending', () => {
    const sent = [{ docKey: 'terms', version: '1.1' }];
    expect(computePendingNotices(p, sent, sent)).toEqual([]);
  });
  it('a sent NON-material or NON-current version is never pending', () => {
    expect(
      computePendingNotices(LEGAL_POLICIES, [{ docKey: 'privacy', version: '1.0' }], [])
    ).toEqual([]);
    expect(computePendingNotices(p, [{ docKey: 'terms', version: '1.0' }], [])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/shared/src/__tests__/legal-policies.test.ts`
Expected: FAIL, `Failed to resolve import "../legal"`.

- [ ] **Step 3: Write the implementation**

`packages/shared/src/legal/index.ts`:

```ts
/**
 * Ebda Store legal documents: the version of each one that is current, when it was published,
 * when it takes effect, and whether the change was material (Ruling LEGAL-4).
 *
 * The policy TEXT lives in apps/marketing/src/lib/legal-{ar,en}.ts. Publishing a change =
 * edit that text AND append a `history` entry here IN THE SAME PR
 * (docs/runbooks/legal-policy-change.md). The marketing pages render their "last updated" line
 * from this registry; the API uses it to record acceptance at signup and to decide which
 * notices a merchant still has to see.
 *
 * Pure module: it imports only the brand, so the static marketing site can import it via
 * `@ebda/shared/legal` without the shared barrel.
 */
import { BRAND } from '../brand';

export const LEGAL_DOC_KEYS = ['legal', 'privacy', 'terms', 'acceptableUse', 'merchant'] as const;
export type LegalDocKey = (typeof LEGAL_DOC_KEYS)[number];

export interface LegalVersion {
  /** Dotted numbers ("1.0", "1.1"), strictly newer than the previous entry. */
  version: string;
  /** YYYY-MM-DD: shown as "Last updated" on the page. */
  publishedAt: string;
  /** YYYY-MM-DD: when this version binds. A fee change needs >= publishedAt + 30 days. */
  effectiveAt: string;
  /** Material = announced: dashboard banner + email to every store owner. */
  material: boolean;
  /** Affects fees: always material, and 30 days' notice (Terms, "Changes to these terms"). */
  feeChange: boolean;
  /** What changed, one or two sentences, shown in the banner and the email. */
  summary: { ar: string; en: string };
}

export type LegalPolicies = Readonly<
  Record<LegalDocKey, { readonly history: readonly LegalVersion[] }>
>;

/** Days of notice the Terms promise before a fee change takes effect. */
export const LEGAL_FEE_NOTICE_DAYS = 30;

const FIRST_VERSION: LegalVersion = {
  version: '1.0',
  publishedAt: '2026-10-07',
  effectiveAt: '2026-10-07',
  material: false,
  feeChange: false,
  summary: { ar: 'الإصدار الأول.', en: 'First version.' },
};

/** Oldest first; the LAST entry is the current version. */
export const LEGAL_POLICIES: LegalPolicies = {
  legal: { history: [{ ...FIRST_VERSION }] },
  privacy: { history: [{ ...FIRST_VERSION }] },
  terms: { history: [{ ...FIRST_VERSION }] },
  acceptableUse: { history: [{ ...FIRST_VERSION }] },
  merchant: { history: [{ ...FIRST_VERSION }] },
};

/** Document titles, identical to the marketing pages' titles (parity-tested in marketing-site.test.tsx). */
export const LEGAL_DOC_TITLE: Readonly<Record<LegalDocKey, { ar: string; en: string }>> = {
  legal: { ar: 'الإشعار القانوني', en: 'Legal notice' },
  privacy: { ar: 'سياسة الخصوصية', en: 'Privacy policy' },
  terms: { ar: 'شروط الخدمة', en: 'Terms of service' },
  acceptableUse: { ar: 'سياسة الاستخدام المقبول', en: 'Acceptable use policy' },
  merchant: { ar: 'اتفاقية التاجر', en: 'Merchant agreement' },
};

/** Path segment of each document on ebda.app (apps/marketing/src/lib/site.ts LEGAL_SLUGS). */
export const LEGAL_DOC_SLUG: Readonly<Record<LegalDocKey, string>> = {
  legal: 'legal',
  privacy: 'privacy',
  terms: 'terms',
  acceptableUse: 'acceptable-use',
  merchant: 'merchant-agreement',
};

export function isLegalDocKey(x: unknown): x is LegalDocKey {
  return typeof x === 'string' && (LEGAL_DOC_KEYS as readonly string[]).includes(x);
}

export function currentLegalVersion(policies: LegalPolicies, key: LegalDocKey): LegalVersion {
  const h = policies[key].history;
  return h[h.length - 1];
}

export function findLegalVersion(
  policies: LegalPolicies,
  key: string,
  version: string
): LegalVersion | null {
  if (!isLegalDocKey(key)) return null;
  return policies[key].history.find(e => e.version === version) ?? null;
}

/** Numeric compare of dotted versions: > 0 when `a` is newer. */
export function compareLegalVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const VERSION = /^\d+(\.\d+)*$/;
const DAY_MS = 86_400_000;
const utc = (isoDate: string) => Date.parse(`${isoDate}T00:00:00Z`);

/** Every broken invariant as a readable line; `[]` = valid. Enforced by legal-policies.test.ts. */
export function validateLegalPolicies(
  policies: Record<string, { history: readonly LegalVersion[] } | undefined>
): string[] {
  const errors: string[] = [];
  for (const key of LEGAL_DOC_KEYS) {
    const history = policies[key]?.history;
    if (!history || history.length === 0) {
      errors.push(`${key}: no entry`);
      continue;
    }
    history.forEach((e, i) => {
      const at = `${key}@${e.version}`;
      if (!VERSION.test(e.version)) errors.push(`${at}: version must be dotted numbers`);
      if (!ISO_DATE.test(e.publishedAt) || !ISO_DATE.test(e.effectiveAt)) {
        errors.push(`${at}: dates must be YYYY-MM-DD`);
        return;
      }
      const pub = utc(e.publishedAt);
      const eff = utc(e.effectiveAt);
      if (eff < pub) errors.push(`${at}: effectiveAt before publishedAt`);
      if (e.feeChange && !e.material) errors.push(`${at}: a fee change is always material`);
      if (e.feeChange && eff < pub + LEGAL_FEE_NOTICE_DAYS * DAY_MS) {
        errors.push(`${at}: a fee change needs ${LEGAL_FEE_NOTICE_DAYS} days' notice`);
      }
      if (!e.summary.ar.trim() || !e.summary.en.trim())
        errors.push(`${at}: summary needs ar and en`);
      const prev = history[i - 1];
      if (prev) {
        if (compareLegalVersions(e.version, prev.version) <= 0) {
          errors.push(`${at}: not newer than ${prev.version}`);
        }
        if (ISO_DATE.test(prev.publishedAt) && pub < utc(prev.publishedAt)) {
          errors.push(`${at}: published before ${prev.version}`);
        }
      }
    });
  }
  for (const key of Object.keys(policies)) {
    if (!isLegalDocKey(key)) errors.push(`${key}: unknown document`);
  }
  return errors;
}

/** The public page of a document on ebda.app (Arabic at the root, English under /en). */
export function legalPolicyUrl(key: LegalDocKey, lang: 'ar' | 'en'): string {
  return `https://${BRAND.domains.marketing}${lang === 'en' ? '/en' : ''}/${LEGAL_DOC_SLUG[key]}/`;
}

/** "7 October 2026" / "7 أكتوبر 2026": Latin digits (NUMERALS-1), read as a UTC calendar date. */
export function formatLegalDate(isoDate: string, lang: 'ar' | 'en'): string {
  return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${isoDate}T00:00:00Z`));
}

export interface LegalDocRef {
  docKey: string;
  version: string;
}

export interface PendingLegalNotice {
  docKey: LegalDocKey;
  version: string;
  effectiveAt: string;
  summary: { ar: string; en: string };
  title: { ar: string; en: string };
  url: { ar: string; en: string };
}

/**
 * The notices a merchant still has to see: for each document, its CURRENT version when that
 * version is material, has been sent (a `legal_notice_sends` row) and is not yet accepted by
 * this user (a `legal_acceptances` row). Superseded versions are never pending.
 */
export function computePendingNotices(
  policies: LegalPolicies,
  sent: readonly LegalDocRef[],
  accepted: readonly LegalDocRef[]
): PendingLegalNotice[] {
  const has = (list: readonly LegalDocRef[], key: string, version: string) =>
    list.some(r => r.docKey === key && r.version === version);
  const out: PendingLegalNotice[] = [];
  for (const key of LEGAL_DOC_KEYS) {
    const cur = currentLegalVersion(policies, key);
    if (!cur.material) continue;
    if (!has(sent, key, cur.version) || has(accepted, key, cur.version)) continue;
    out.push({
      docKey: key,
      version: cur.version,
      effectiveAt: cur.effectiveAt,
      summary: cur.summary,
      title: LEGAL_DOC_TITLE[key],
      url: { ar: legalPolicyUrl(key, 'ar'), en: legalPolicyUrl(key, 'en') },
    });
  }
  return out;
}
```

`packages/shared/src/index.ts`: add after `export * from './setup-guide';`

```ts
export * from './legal';
```

`packages/shared/package.json`: add inside `exports`, right after the `"./brand"` entry:

```json
    "./legal": {
      "types": "./src/legal/index.ts",
      "default": "./src/legal/index.ts"
    },
```

`vitest.shared.ts`, inside `workspaceAliases`, right after the `'@ebda/shared/brand'` line:

```ts
    // Pure legal-policy registry (marketing imports it without the shared barrel).
    '@ebda/shared/legal': path.resolve(root, './packages/shared/src/legal'),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/shared/src/__tests__/legal-policies.test.ts && tsc --noEmit -p packages/shared/tsconfig.json`
Expected: all tests PASS, tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/legal/index.ts packages/shared/src/__tests__/legal-policies.test.ts packages/shared/src/index.ts packages/shared/package.json vitest.shared.ts
git commit -m "feat(legal): versioned legal policy registry in shared"
```

---

### Task 2: Marketing pages render date and version from the registry

**Files:**

- Modify: `apps/marketing/src/lib/legal-types.ts:7-10`
- Modify: `apps/marketing/src/lib/legal-en.ts:6-14`
- Modify: `apps/marketing/src/lib/legal-ar.ts:6-13`
- Modify: `apps/marketing/src/components/LegalPage.tsx:1-31`
- Modify: `apps/marketing/tsconfig.json` (`paths`)
- Test: `tests/unit/marketing-site.test.tsx` (replace the two tests at lines 494-519 and add two)

**Interfaces:**

- Consumes: `LEGAL_POLICIES`, `currentLegalVersion`, `formatLegalDate`, `LEGAL_DOC_TITLE`, `LEGAL_DOC_SLUG`, `type LegalDocKey` (Task 1).
- Produces: `LegalPages.updated` is now `{ label: string; versionLabel: string }`.

- [ ] **Step 1: Write the failing test**

In `tests/unit/marketing-site.test.tsx`, add imports at the top (after the `site` import):

```ts
import {
  LEGAL_POLICIES,
  LEGAL_DOC_TITLE,
  LEGAL_DOC_SLUG,
  currentLegalVersion,
  formatLegalDate,
  type LegalDocKey,
} from '../../packages/shared/src/legal';
import { COPY } from '../../apps/marketing/src/lib/content';

const DOC_OF: Record<(typeof LEGAL_SLUGS)[number], LegalDocKey> = {
  legal: 'legal',
  privacy: 'privacy',
  terms: 'terms',
  'merchant-agreement': 'merchant',
  'acceptable-use': 'acceptableUse',
};
```

Replace the test `'llms.txt and og assets exist; legal pages show their version with no registration numbers'` with:

```ts
  it('llms.txt and og assets exist; legal pages show their version with no registration numbers', () => {
    expect(pub('llms.txt')).toMatch(/^# Ebda/);
    expect(pub('og.png').length).toBeGreaterThan(1000);
    for (const [locale, word] of [
      ['ar', 'الإصدار'],
      ['en', 'Version'],
    ] as const) {
      for (const page of LEGAL_SLUGS) {
        const cur = currentLegalVersion(LEGAL_POLICIES, DOC_OF[page]);
        const html = renderToStaticMarkup(<LegalPage locale={locale} page={page} />);
        expect(html).toContain(`${word} ${cur.version}`);
        // the WhatsApp button's wa.me href is the only long number on the page, and it is not a registration number
        const withoutPhone = html.replace(/201514191411/g, '');
        expect(withoutPhone).not.toMatch(/\b\d{5,}\b/);
      }
    }
  });
```

Replace `expect(html).toContain('2026-10-07');` in `'every legal page (both locales) is versioned, names the contact, and has no placeholders'` with:

```ts
expect(html).toContain(currentLegalVersion(LEGAL_POLICIES, DOC_OF[page]).publishedAt);
```

Add, inside the same `describe` block:

```ts
  it("each legal page's date and version equal LEGAL_POLICIES, in ar and en (Ruling LEGAL-4)", () => {
    for (const locale of ['ar', 'en'] as const)
      for (const page of LEGAL_SLUGS) {
        const cur = currentLegalVersion(LEGAL_POLICIES, DOC_OF[page]);
        const html = renderToStaticMarkup(<LegalPage locale={locale} page={page} />).toLowerCase();
        expect(html).toContain(
          `<time datetime="${cur.publishedAt}">${formatLegalDate(cur.publishedAt, locale).toLowerCase()}</time>`
        );
      }
  });

  it('the legal copy holds no date or version literal, and the registry titles/slugs match the pages', () => {
    for (const locale of ['ar', 'en'] as const) {
      const lp = COPY[locale].legalPages;
      expect(Object.keys(lp.updated).sort()).toEqual(['label', 'versionLabel']);
      expect(lp.notice).not.toMatch(/\d/);
      for (const page of LEGAL_SLUGS) {
        const key = DOC_OF[page];
        expect(LEGAL_DOC_TITLE[key][locale]).toBe(lp[key].title);
        expect(LEGAL_DOC_SLUG[key]).toBe(page);
      }
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/marketing-site.test.tsx`
Expected: FAIL. The new date test finds `<time datetime="2026-10-07">` (the attribute is still hard-coded and the date comes from the copy, so it may pass), but `Object.keys(lp.updated)` is `['date','label','version']` and the notice contains `1.0`, so the copy test fails.

- [ ] **Step 3: Write the implementation**

`apps/marketing/src/lib/legal-types.ts`, replace lines 7-8:

```ts
/**
 * Labels of the "last updated" line. The date and the version themselves come from
 * LEGAL_POLICIES in @ebda/shared/legal (Ruling LEGAL-4), never from this copy.
 */
updated: {
  label: string;
  versionLabel: string;
}
```

`apps/marketing/src/lib/legal-en.ts`, replace the header comment and lines 11-14:

```ts
/**
 * English legal text. Version, publish date and effective date of each document live in
 * LEGAL_POLICIES (packages/shared/src/legal); bump it in the same PR as any text change
 * (docs/runbooks/legal-policy-change.md). Original wording written from the common protective
 * structure of SaaS store-builder terms; not reviewed by counsel.
 */
export const LEGAL_EN: LegalPages = {
  updated: { label: 'Last updated', versionLabel: 'Version' },
  toc: 'On this page',
  notice:
    'We may update this document as described in its "Changes" section. The Arabic text is the primary text.',
```

`apps/marketing/src/lib/legal-ar.ts`, replace the header comment and lines 11-13:

```ts
/**
 * النص العربي (الأصل المعتمد). رقم الإصدار وتاريخ النشر وتاريخ السريان لكل وثيقة في
 * LEGAL_POLICIES (packages/shared/src/legal)؛ يُحدَّث في نفس الـ PR مع أي تعديل في النص.
 * صياغة أصلية على نمط الشروط الحمائية المعتادة لمنصات بناء المتاجر؛ لم تُراجع من مستشار قانوني.
 */
export const LEGAL_AR: LegalPages = {
  updated: { label: 'آخر تحديث:', versionLabel: 'الإصدار' },
  toc: 'في الصفحة دي',
  notice: 'قد نحدّث هذه الوثيقة وفق قسم «التعديلات». النص العربي هو النص المعتمد.',
```

`apps/marketing/src/components/LegalPage.tsx`: add the import below the existing imports and replace the `legal-meta` paragraph:

```tsx
import { LEGAL_POLICIES, currentLegalVersion, formatLegalDate } from '@ebda/shared/legal';
```

```tsx
export function LegalPage({ locale, page }: { locale: Locale; page: LegalSlug }) {
  const c = COPY[locale].legalPages;
  const doc = c[DOC_KEY[page]];
  const current = currentLegalVersion(LEGAL_POLICIES, DOC_KEY[page]);
  return (
    <>
      <Header locale={locale} page={page} />
      <main id="main" className="wrap legal">
        <header className="legal-head">
          <h1>{doc.title}</h1>
          <p className="legal-meta">
            {c.updated.label}{' '}
            <time dateTime={current.publishedAt}>
              {formatLegalDate(current.publishedAt, locale)}
            </time>{' '}
            · {c.updated.versionLabel} {current.version}
          </p>
          <p className="legal-notice">{c.notice}</p>
        </header>
```

(The rest of the component is unchanged. `DOC_KEY` values are exactly `LegalDocKey` names.)

`apps/marketing/tsconfig.json`, add to `paths` after the brand entry:

```json
      "@ebda/shared/legal": ["../../packages/shared/src/legal"],
```

- [ ] **Step 4: Run tests and build to verify**

Run: `npx vitest run tests/unit/marketing-site.test.tsx && tsc --noEmit -p apps/marketing/tsconfig.json && npm run build -w apps/marketing && grep -o '<time[^<]*</time>' apps/marketing/out/terms/index.html apps/marketing/out/en/terms/index.html`
Expected: tests PASS, tsc exits 0, build succeeds, grep prints `<time dateTime="2026-10-07">7 أكتوبر 2026</time>` for `out/terms` and `<time dateTime="2026-10-07">7 October 2026</time>` for `out/en/terms` (attribute case may be lowercase).

- [ ] **Step 5: Commit**

```bash
git add apps/marketing/src/lib/legal-types.ts apps/marketing/src/lib/legal-en.ts apps/marketing/src/lib/legal-ar.ts apps/marketing/src/components/LegalPage.tsx apps/marketing/tsconfig.json tests/unit/marketing-site.test.tsx
git commit -m "feat(marketing): legal pages render date and version from the policy registry"
```

---

### Task 3: Tables, RLS and tenant-guard classification

**Files:**

- Modify: `packages/database/prisma/schema.prisma` (User relations near line 98; new models after `model SystemSetting`, line ~2108)
- Create: `packages/database/prisma/migrations/20261017000100_legal_acceptances_and_notices/migration.sql`
- Create: `packages/database/prisma/migrations/20261017000100_legal_acceptances_and_notices/rollback.sql`
- Modify: `packages/database/src/tenant-guard.ts:106-124` (`USER_KEYED_MODELS`, `GLOBAL_MODELS`)
- Regenerate: `packages/database/src/tenant-guard-schema.generated.ts`
- Modify: `tests/integration/rls-ebda-app.test.ts:81-86` (`DOCUMENTED_NON_RLS`) and `:1537` (`USER_KEYED`)
- Test: `tests/integration/legal-tables-rls.test.ts` (new)

**Interfaces:**

- Produces Prisma models `LegalAcceptance`, `LegalNoticeSend`, `LegalNoticeDelivery` with compound unique keys `userId_docKey_version` and `docKey_version`; delivery `status` in `'queued' | 'sending' | 'sent' | 'failed'`; acceptance `source` in `'signup' | 'notice_ack'`.

- [ ] **Step 1: Write the failing test**

`tests/integration/legal-tables-rls.test.ts`:

```ts
/**
 * Ruling LEGAL-4 tables under strict RLS, as the real `ebda_app` login:
 *   - legal_acceptances / legal_notice_deliveries are user-keyed: a user sees and writes only
 *     their own rows, a contextless read sees none;
 *   - legal_acceptances is append-only for ebda_app (UPDATE/DELETE revoked);
 *   - legal_notice_sends is platform-global (documented exception) and readable by any user;
 *   - deleting a user cascades to their legal rows, including a super-admin hard delete.
 * Raw SQL on purpose: it proves the DATABASE layer (the guard allows raw SQL under a scope).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import {
  createPrismaClient,
  runWithRequestDb,
  withUser,
  asPlatformOperator,
  prisma,
  type AppPrismaClient,
} from '@ebda/database';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const APP_PASSWORD = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
const hasDb = !!OWNER_URL && !OWNER_URL.includes('localhost:5432/test_db');
const run = crypto.randomUUID().slice(0, 8);

function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = APP_PASSWORD;
  return u.toString();
}
const asApp = <T>(fn: () => Promise<T>) =>
  runWithRequestDb(() => createPrismaClient({ connectionString: appUrl(), max: 2 }), fn);

describe.skipIf(!hasDb)('legal tables under strict RLS', () => {
  let owner: AppPrismaClient;
  const users: Record<'a' | 'b' | 'op', string> = { a: '', b: '', op: '' };

  const mkUser = async (tag: string, role: 'store_admin' | 'super_admin') =>
    (
      await owner.user.create({
        data: {
          email: `ltr-${tag}-${run}-${crypto.randomUUID().slice(0, 6)}@test.local`,
          passwordHash: 'x',
          firstName: 'L',
          lastName: tag,
          role,
          emailVerified: true,
        },
      })
    ).id;

  beforeAll(async () => {
    owner = createPrismaClient({ connectionString: OWNER_URL, max: 2, role: 'owner' });
    users.a = await mkUser('a', 'store_admin');
    users.b = await mkUser('b', 'store_admin');
    users.op = await mkUser('op', 'super_admin');
    for (const userId of [users.a, users.b]) {
      await owner.legalAcceptance.create({
        data: { userId, docKey: 'terms', version: '1.0', source: 'signup' },
      });
      await owner.legalNoticeDelivery.create({
        data: { userId, docKey: 'terms', version: '1.0' },
      });
    }
  });

  afterAll(async () => {
    await owner.user.deleteMany({ where: { id: { in: Object.values(users).filter(Boolean) } } });
    await owner.$disconnect();
  });

  for (const table of ['legal_acceptances', 'legal_notice_deliveries']) {
    it(`${table}: a user sees only their own rows; contextless sees none`, async () => {
      const seenByA = await asApp(() =>
        withUser(users.a, () =>
          prisma.$queryRawUnsafe<Array<{ user_id: string }>>(
            `SELECT user_id FROM public."${table}" WHERE user_id IN ($1, $2)`,
            users.a,
            users.b
          )
        )
      );
      expect(seenByA.map(r => r.user_id)).toEqual([users.a]);
      const contextless = await asApp(() =>
        prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM public."${table}"`)
      );
      expect(Number(contextless[0].n)).toBe(0);
    });

    it(`${table}: a user cannot write a row for someone else`, async () => {
      await expect(
        asApp(() =>
          withUser(users.a, () =>
            prisma.$executeRawUnsafe(
              `INSERT INTO public."${table}" (id, user_id, doc_key, version${
                table === 'legal_acceptances' ? ', source' : ', updated_at'
              }) VALUES ($1, $2, 'privacy', '1.0', ${
                table === 'legal_acceptances' ? "'signup'" : 'now()'
              })`,
              crypto.randomUUID(),
              users.b
            )
          )
        )
      ).rejects.toThrow(/row-level security/i);
    });
  }

  it('legal_acceptances is append-only for ebda_app', async () => {
    await expect(
      asApp(() =>
        withUser(users.a, () =>
          prisma.$executeRawUnsafe(
            `UPDATE public.legal_acceptances SET version = '9.9' WHERE user_id = $1`,
            users.a
          )
        )
      )
    ).rejects.toThrow(/permission denied/i);
  });

  it('legal_notice_sends is readable by any signed-in user (platform-global)', async () => {
    const docKey = 'legal';
    const version = `0.${run.replace(/\D/g, '').slice(0, 6) || '1'}`;
    await owner.legalNoticeSend.create({ data: { docKey, version, sentBy: users.op } });
    try {
      const rows = await asApp(() =>
        withUser(users.a, () =>
          prisma.legalNoticeSend.findMany({ where: { docKey, version }, select: { version: true } })
        )
      );
      expect(rows).toEqual([{ version }]);
    } finally {
      await owner.legalNoticeSend.deleteMany({ where: { docKey, version } });
    }
  });

  it('a super-admin hard delete of a user cascades to their legal rows', async () => {
    const victim = await mkUser('victim', 'store_admin');
    await owner.legalAcceptance.create({
      data: { userId: victim, docKey: 'terms', version: '1.0', source: 'signup' },
    });
    await asApp(() =>
      asPlatformOperator(users.op, () => prisma.user.delete({ where: { id: victim } }))
    );
    expect(await owner.legalAcceptance.count({ where: { userId: victim } })).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (with the Test environment exported): `npx vitest run tests/integration/legal-tables-rls.test.ts --retry=0`
Expected: FAIL, TypeScript/Prisma error `Property 'legalAcceptance' does not exist on type`.

- [ ] **Step 3: Write the implementation**

`schema.prisma`: in `model User`'s `// Relations` block, after `staffMemberships ...`:

```prisma
  legalAcceptances         LegalAcceptance[]
  legalNoticeDeliveries    LegalNoticeDelivery[]
```

After `model SystemSetting { ... }`:

```prisma
// ==========================================
// Legal: policy acceptance + material-change notices (Ruling LEGAL-4)
// Versions live in code (packages/shared/src/legal LEGAL_POLICIES); these tables record
// what each user accepted and which versions were announced.
// ==========================================

/// One row per user per accepted document version. Append-only for ebda_app (UPDATE/DELETE
/// revoked in the migration). source: 'signup' (click-wrap) | 'notice_ack' (dashboard "Got it").
model LegalAcceptance {
  id         String   @id @default(uuid())
  userId     String   @map("user_id")
  docKey     String   @map("doc_key")
  version    String
  acceptedAt DateTime @default(now()) @map("accepted_at")
  ip         String?
  userAgent  String?  @map("user_agent")
  source     String

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([userId, docKey, version])
  @@map("legal_acceptances")
}

/// One row per announced (material) version: written by the super-admin "Send notice".
/// Platform-global (no user data): the banner reads it for every merchant.
model LegalNoticeSend {
  id             String   @id @default(uuid())
  docKey         String   @map("doc_key")
  version        String
  sentAt         DateTime @default(now()) @map("sent_at")
  /// The super_admin who pressed "Send notice" (not a FK: the record outlives the account).
  sentBy         String   @map("sent_by")
  /// Set by the fan-out once recipients are materialized.
  recipientCount Int?     @map("recipient_count")

  @@unique([docKey, version])
  @@map("legal_notice_sends")
}

/// The email fan-out ledger: one row per recipient per announced version. A row leaves
/// 'queued' (-> 'sending') BEFORE the mail is sent, so a retry never mails twice.
/// status: queued | sending | sent | failed
model LegalNoticeDelivery {
  id        String   @id @default(uuid())
  userId    String   @map("user_id")
  docKey    String   @map("doc_key")
  version   String
  status    String   @default("queued")
  error     String?
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([userId, docKey, version])
  @@index([docKey, version, status])
  @@map("legal_notice_deliveries")
}
```

`migration.sql`:

```sql
-- 20261017000100_legal_acceptances_and_notices (Ruling LEGAL-4)
--
--   legal_acceptances        NEW, user-keyed. What each user accepted (signup click-wrap, dashboard
--                            "Got it"). Append-only for ebda_app: UPDATE/DELETE revoked below; the
--                            users FK cascade still removes them (referential actions are not
--                            subject to the referencing role's grants or RLS).
--   legal_notice_sends       NEW, platform-global (documented exception in
--                            tests/integration/rls-ebda-app.test.ts): one row per announced version.
--   legal_notice_deliveries  NEW, user-keyed. Email fan-out ledger, one row per recipient per version.
--
-- Additive only, all three tables empty at creation, so plain CREATE INDEX is correct
-- (docs/DB-INDEX-MIGRATIONS.md); no lock_timeout. FKs: users CASCADE (no NO ACTION child added).
-- ebda_app gets SELECT/INSERT/UPDATE/DELETE from the default privileges of
-- 20261004000000_ebda_strict_rls. Rollback: rollback.sql next to this file.

CREATE TABLE "legal_acceptances" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "doc_key" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "user_agent" TEXT,
    "source" TEXT NOT NULL,

    CONSTRAINT "legal_acceptances_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "legal_acceptances_source_check" CHECK ("source" IN ('signup', 'notice_ack'))
);
CREATE UNIQUE INDEX "legal_acceptances_user_id_doc_key_version_key" ON "legal_acceptances"("user_id", "doc_key", "version");
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "legal_notice_sends" (
    "id" TEXT NOT NULL,
    "doc_key" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_by" TEXT NOT NULL,
    "recipient_count" INTEGER,

    CONSTRAINT "legal_notice_sends_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "legal_notice_sends_doc_key_version_key" ON "legal_notice_sends"("doc_key", "version");

CREATE TABLE "legal_notice_deliveries" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "doc_key" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "legal_notice_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "legal_notice_deliveries_status_check" CHECK ("status" IN ('queued', 'sending', 'sent', 'failed'))
);
CREATE UNIQUE INDEX "legal_notice_deliveries_user_id_doc_key_version_key" ON "legal_notice_deliveries"("user_id", "doc_key", "version");
CREATE INDEX "legal_notice_deliveries_doc_key_version_status_idx" ON "legal_notice_deliveries"("doc_key", "version", "status");
ALTER TABLE "legal_notice_deliveries" ADD CONSTRAINT "legal_notice_deliveries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- User-keyed strict RLS, same shape as refresh_tokens (20261008000100_tenant_defence_contract):
-- the row's user, or an ACTIVE super_admin (the fan-out runs as the operator who pressed send).
DO $legal_user_keyed$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['legal_acceptances', 'legal_notice_deliveries'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS ebda_user_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY ebda_user_isolation ON public.%I AS PERMISSIVE FOR ALL TO ebda_app '
      'USING (user_id = nullif(current_setting(''app.current_user_id'', true), '''') OR public.ebda_is_super_admin()) '
      'WITH CHECK (user_id = nullif(current_setting(''app.current_user_id'', true), '''') OR public.ebda_is_super_admin())',
      t
    );
  END LOOP;
END
$legal_user_keyed$;

-- Acceptance is a legal record: the app may add rows, never rewrite or remove them.
REVOKE UPDATE, DELETE ON "legal_acceptances" FROM ebda_app;
```

`rollback.sql`:

```sql
-- Rollback of 20261017000100_legal_acceptances_and_notices: drops the three tables (the
-- acceptance history is lost; take a pg_dump of them first). Then revert the PR so
-- schema.prisma no longer declares the models, and `prisma migrate resolve --rolled-back`.
DROP TABLE IF EXISTS "legal_notice_deliveries";
DROP TABLE IF EXISTS "legal_notice_sends";
DROP TABLE IF EXISTS "legal_acceptances";
```

`packages/database/src/tenant-guard.ts`:

```ts
export const USER_KEYED_MODELS: Readonly<Record<string, string>> = {
  Address: 'userId',
  // Ruling LEGAL-4: what a user accepted, and the per-recipient email ledger.
  LegalAcceptance: 'userId',
  LegalNoticeDelivery: 'userId',
  OneSignalSubscription: 'userId',
  RefreshToken: 'userId',
  VerificationToken: 'userId',
};
```

```ts
export const GLOBAL_MODELS: readonly string[] = [
  'AnswerEngineProviderConfig',
  'BillingWebhookEvent',
  // Ruling LEGAL-4: one row per announced policy version, read by every merchant.
  'LegalNoticeSend',
  'Plan',
  'SystemSetting',
];
```

`tests/integration/rls-ebda-app.test.ts`:

```ts
const DOCUMENTED_NON_RLS: Record<string, string> = {
  answer_engine_provider_configs: 'platform-global provider credentials (no tenant, no user)',
  _prisma_migrations: 'migration bookkeeping; not granted to ebda_app',
  plans: 'platform-global plan catalog (config; no tenant data, no store_id)',
  billing_webhook_events: 'provider-event dedupe ledger (no store_id, no tenant data)',
  legal_notice_sends:
    'announced policy versions (Ruling LEGAL-4): platform-global, read by every merchant',
};
```

```ts
const USER_KEYED = [
  'refresh_tokens',
  'verification_tokens',
  'onesignal_subscriptions',
  'legal_acceptances',
  'legal_notice_deliveries',
];
```

Then regenerate the client and the guard snapshot:

```bash
npm run db:generate
npm run gen:tenant-guard-schema -w packages/database
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npx prisma migrate deploy --schema packages/database/prisma/schema.prisma
npx vitest run tests/unit/tenant-guard-models.test.ts tests/unit/tenant-guard-schema-snapshot.test.ts
npx vitest run tests/integration/legal-tables-rls.test.ts tests/integration/rls-ebda-app.test.ts --retry=0
npm run gen:tenant-guard-schema -w packages/database -- --check
psql "$DATABASE_URL" -c "SELECT constraint_name, delete_rule FROM information_schema.referential_constraints WHERE constraint_name LIKE 'legal_%'"
```

Expected: the migration applies; all tests PASS (the guard-models test now has two more user-keyed cases); `--check` exits 0; psql shows `legal_acceptances_user_id_fkey | CASCADE` and `legal_notice_deliveries_user_id_fkey | CASCADE`, and no `NO ACTION`.

- [ ] **Step 5: Commit**

```bash
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations/20261017000100_legal_acceptances_and_notices packages/database/src/tenant-guard.ts packages/database/src/tenant-guard-schema.generated.ts tests/integration/rls-ebda-app.test.ts tests/integration/legal-tables-rls.test.ts
git commit -m "feat(db): legal acceptance and notice tables under user-keyed rls"
```

---

### Task 4: Signup click-wrap (API refuses without it, records acceptance)

**Files:**

- Create: `apps/api/src/services/legal-notice.service.ts` (first slice)
- Modify: `apps/api/src/services/merchant-signup.service.ts` (schema + `signup()`)
- Modify: `apps/admin/src/app/signup/page.tsx`
- Modify: `apps/admin/src/i18n/messages/en.json`, `ar.json` (`onboarding.signup.legal`, `onboarding.signup.errors.legalRequired`)
- Modify (callers that must now send `acceptedLegal: true`): `tests/integration/self-serve-onboarding.test.ts` (`signup()` helper), `tests/integration/self-serve-onboarding-live.test.ts:100`, `tests/integration/store-creation-tenant-guard.test.ts:112`, `tests/integration/merchant-password-reset.test.ts:73`, `tests/integration/merchant-signup-abuse.test.ts` (`body()` helper), `scripts/ebda-e2e-self-serve.mjs:117`, `tests/unit/ebda-ads-signup-persist.test.ts`, `tests/unit/merchant-signup-phone.test.ts`, `apps/admin/src/app/signup/page.test.tsx`
- Test: `tests/unit/merchant-signup-legal.test.ts` (new), `tests/integration/legal-signup-acceptance.test.ts` (new)

**Interfaces:**

- Consumes: `LEGAL_POLICIES`, `LEGAL_DOC_KEYS`, `currentLegalVersion`, `legalPolicyUrl`, `type LegalPolicies` (Task 1); Prisma `legalAcceptance` (Task 3).
- Produces (in `legal-notice.service.ts`, used by Tasks 5, 7, 8):
  - `activeLegalPolicies(): LegalPolicies`
  - `__setLegalPoliciesForTests(p: LegalPolicies | null): void`
  - `signupAcceptanceRows(userId: string, request: { ip?: string; userAgent?: string }, now?: Date): Array<{ userId; docKey; version; acceptedAt; ip; userAgent; source: 'signup' }>`
  - `LEGAL_UA_MAX = 512`
- `merchantSignupSchema` gains `acceptedLegal: true` (literal).

- [ ] **Step 1: Write the failing tests**

`tests/unit/merchant-signup-legal.test.ts`:

```ts
/**
 * Signup click-wrap (Ruling LEGAL-4): the API refuses a signup that did not accept the
 * policies, and records the CURRENT version of all five documents in the SAME transaction
 * as the new account's profile write.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { txLog } = vi.hoisted(() => ({
  txLog: [] as Array<{ tx: number; op: string; args: any }>,
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('bcryptjs', () => ({ default: { hash: async () => 'hash', compare: async () => false } }));
vi.mock('@ebda/database', () => {
  let n = 0;
  return {
    withUser: async (_id: string, fn: (tx: unknown) => unknown) => {
      const tx = ++n;
      return fn({
        user: {
          findUnique: async () => null,
          update: async (args: unknown) => (txLog.push({ tx, op: 'user.update', args }), {}),
        },
        legalAcceptance: {
          createMany: async (args: unknown) => (
            txLog.push({ tx, op: 'legalAcceptance.createMany', args }),
            { count: 5 }
          ),
        },
      });
    },
  };
});
vi.mock('@api/lib/definer', () => ({
  findUserIdByEmail: async () => null,
  ensureAdminUser: async () => ({
    created: true,
    id: 'u1',
    email: 'a@b.co',
    firstName: 'A',
    lastName: 'B',
  }),
}));
vi.mock('@api/services/auth.service', () => ({
  AuthService: { sendVerificationEmail: async () => undefined },
}));
vi.mock('@api/services/platform-mailer', () => ({
  sendMerchantDuplicateSignupNotice: async () => undefined,
}));

import { MerchantSignupService, merchantSignupSchema } from '@api/services/merchant-signup.service';
import { LEGAL_DOC_KEYS, LEGAL_POLICIES, currentLegalVersion } from '@ebda/shared';

const base = {
  email: 'a@b.co',
  name: 'Mona Ali',
  password: 'Str0ng!Passw0rd',
  phone: '01012345678',
  language: 'ar' as const,
};

beforeEach(() => {
  txLog.length = 0;
});

describe('signup click-wrap', () => {
  it('the schema refuses a missing or false acceptedLegal', () => {
    expect(merchantSignupSchema.safeParse(base).success).toBe(false);
    expect(merchantSignupSchema.safeParse({ ...base, acceptedLegal: false }).success).toBe(false);
    expect(merchantSignupSchema.safeParse({ ...base, acceptedLegal: 'true' }).success).toBe(false);
    expect(merchantSignupSchema.safeParse({ ...base, acceptedLegal: true }).success).toBe(true);
  });

  it('records the current version of all five documents in the profile transaction', async () => {
    await MerchantSignupService.signup(
      merchantSignupSchema.parse({ ...base, acceptedLegal: true }),
      { ip: '203.0.113.9', userAgent: 'UA/1' }
    );
    const update = txLog.find(l => l.op === 'user.update')!;
    const create = txLog.find(l => l.op === 'legalAcceptance.createMany')!;
    expect(create.tx).toBe(update.tx);
    expect(create.args.skipDuplicates).toBe(true);
    const rows = create.args.data as Array<Record<string, unknown>>;
    expect(rows.map(r => r.docKey).sort()).toEqual([...LEGAL_DOC_KEYS].sort());
    for (const r of rows) {
      expect(r).toMatchObject({
        userId: 'u1',
        version: currentLegalVersion(LEGAL_POLICIES, r.docKey as never).version,
        ip: '203.0.113.9',
        userAgent: 'UA/1',
        source: 'signup',
      });
    }
  });
});
```

`tests/integration/legal-signup-acceptance.test.ts`:

```ts
/**
 * Signup click-wrap over HTTP, on the real merchant-signup router bound to the strict-RLS
 * `ebda_app` login (Ruling LEGAL-4, Review Focus 3): the server refuses a signup without
 * `acceptedLegal: true` even when the UI is bypassed, and a valid signup leaves one
 * legal_acceptances row per document at its current version.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import { createPrismaClient, runWithRequestDb, type AppPrismaClient } from '@ebda/database';
import { LEGAL_DOC_KEYS, LEGAL_POLICIES, currentLegalVersion } from '@ebda/shared';
import merchantSignupRoutes from '@api/routes/merchant-signup.routes';
import { errorHandler } from '@api/middleware/error-handler';
import { awaitDeferredWork } from '@api/lib/after-tenant-commit';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const APP_PASSWORD = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
const hasDb = !!OWNER_URL && !OWNER_URL.includes('localhost:5432/test_db');
const run = crypto.randomUUID().slice(0, 8);

function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = APP_PASSWORD;
  return u.toString();
}
const asApp = <T>(fn: () => Promise<T>) =>
  runWithRequestDb(() => createPrismaClient({ connectionString: appUrl(), max: 3 }), fn, {
    beforeDisconnect: () => awaitDeferredWork(5000),
  });

describe.skipIf(!hasDb)('signup click-wrap (server side)', () => {
  let owner: AppPrismaClient;
  let app: Express;
  const emails: string[] = [];
  process.env.SIGNUP_MIN_FILL_MS = '0';
  process.env.SIGNUP_EMAIL_DOMAIN_DAILY_CAP = '100000';

  const mkEmail = (tag: string) => {
    const e = `lsa-${tag}-${run}-${crypto.randomUUID().slice(0, 6)}@test.local`;
    emails.push(e);
    return e;
  };
  const signup = (email: string, extra: Record<string, unknown>) =>
    asApp(async () => {
      const tok = await request(app).get('/api/v1/auth/merchant/signup-token');
      return request(app)
        .post('/api/v1/auth/merchant/signup')
        .set('User-Agent', 'LegalTest/1')
        .send({
          email,
          password: 'Str0ng!Passw0rd',
          name: 'Mona Hassan',
          phone: `010${crypto.randomInt(10_000_000, 99_999_999)}`,
          formToken: tok.body.data.token,
          ...extra,
        });
    });
  const userByEmail = (email: string) =>
    owner.user.findFirst({ where: { email, storeId: null }, select: { id: true } });

  beforeAll(() => {
    owner = createPrismaClient({ connectionString: OWNER_URL, max: 2, role: 'owner' });
    app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use('/api/v1/auth/merchant', merchantSignupRoutes);
    app.use(errorHandler);
  });

  afterAll(async () => {
    await owner.user.deleteMany({ where: { email: { in: emails }, storeId: null } });
    await owner.$disconnect();
  });

  it('refuses a signup with no acceptedLegal: 400, no account', async () => {
    const email = mkEmail('missing');
    const res = await signup(email, {});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(await userByEmail(email)).toBeNull();
  });

  it('refuses acceptedLegal: false: 400, no account', async () => {
    const email = mkEmail('false');
    const res = await signup(email, { acceptedLegal: false });
    expect(res.status).toBe(400);
    expect(await userByEmail(email)).toBeNull();
  });

  it('records one signup acceptance per document at its current version', async () => {
    const email = mkEmail('ok');
    const res = await signup(email, { acceptedLegal: true });
    expect(res.status).toBe(200);
    const user = await userByEmail(email);
    expect(user).not.toBeNull();
    const rows = await owner.legalAcceptance.findMany({
      where: { userId: user!.id },
      select: { docKey: true, version: true, source: true, userAgent: true, ip: true },
    });
    expect(rows.map(r => r.docKey).sort()).toEqual([...LEGAL_DOC_KEYS].sort());
    for (const r of rows) {
      expect(r.version).toBe(currentLegalVersion(LEGAL_POLICIES, r.docKey as never).version);
      expect(r.source).toBe('signup');
      expect(r.userAgent).toBe('LegalTest/1');
      expect(r.ip).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/merchant-signup-legal.test.ts` and, with the Test environment exported, `npx vitest run tests/integration/legal-signup-acceptance.test.ts --retry=1`
Expected: unit FAIL (`safeParse(base).success` is `true`; no `legalAcceptance.createMany` call); integration FAIL (the missing-checkbox signup answers 200).

- [ ] **Step 3: Write the implementation**

`apps/api/src/services/legal-notice.service.ts` (first slice; Tasks 5, 7 and 8 append to it):

```ts
/**
 * Legal policy acceptance and material-change notices (Ruling LEGAL-4).
 *
 * Versions come from LEGAL_POLICIES (@ebda/shared). This service records acceptance
 * (signup click-wrap, dashboard "Got it"), computes which notices a merchant still has to
 * see, and runs the email fan-out the super-admin "Send notice" starts.
 *
 * Staleness class of the pending-notice read: NEVER-stale. It is computed per request and
 * never cached (no Redis/KV/bounded-map, `Cache-Control: no-store` on the route), so ack
 * and send need no invalidation.
 */
import {
  LEGAL_DOC_KEYS,
  LEGAL_POLICIES,
  currentLegalVersion,
  type LegalPolicies,
} from '@ebda/shared';

/** Longest user-agent stored on an acceptance row. */
export const LEGAL_UA_MAX = 512;

let activePolicies: LegalPolicies = LEGAL_POLICIES;

/** The registry in force (the shipped LEGAL_POLICIES outside tests). */
export function activeLegalPolicies(): LegalPolicies {
  return activePolicies;
}

/** Tests only: run against a fixture registry (e.g. one with a material version). `null` restores. */
export function __setLegalPoliciesForTests(p: LegalPolicies | null): void {
  activePolicies = p ?? LEGAL_POLICIES;
}

/** The click-wrap rows for a new account: every document at its CURRENT version. */
export function signupAcceptanceRows(
  userId: string,
  request: { ip?: string; userAgent?: string },
  now: Date = new Date()
) {
  return LEGAL_DOC_KEYS.map(docKey => ({
    userId,
    docKey,
    version: currentLegalVersion(activePolicies, docKey).version,
    acceptedAt: now,
    ip: request.ip ?? null,
    userAgent: request.userAgent ? request.userAgent.slice(0, LEGAL_UA_MAX) : null,
    source: 'signup' as const,
  }));
}
```

`apps/api/src/services/merchant-signup.service.ts`:

Add the import:

```ts
import { signupAcceptanceRows } from './legal-notice.service';
```

Add to `merchantSignupSchema`, after `tracking`:

```ts
  /**
   * Click-wrap (Ruling LEGAL-4): the visitor ticked "I agree to the Terms, Privacy Policy,
   * Merchant Agreement and Acceptable Use Policy". Required: a signup without it is refused.
   */
  acceptedLegal: z.literal(true, {
    errorMap: () => ({ message: 'You must accept the terms and policies to create an account' }),
  }),
```

In `signup()`, the unverified-existing branch becomes:

```ts
if (existing && existing.role === 'store_admin' && !existing.emailVerified) {
  // Signed up before but never verified (lost mail): treat as a resend. They just
  // accepted the current policies again; record it (a no-op when already recorded).
  await withUser(existing.id, tx =>
    tx.legalAcceptance.createMany({
      data: signupAcceptanceRows(existing.id, request),
      skipDuplicates: true,
    })
  );
  return this.resendVerification(existing.email);
}
```

and the profile write becomes one transaction with the acceptance rows:

```ts
const acquisition = buildAcquisition(input.tracking, request);
// Profile + click-wrap acceptance in ONE transaction, as the new user (Ruling LEGAL-4).
await withUser(created.id, async tx => {
  await tx.user.update({
    where: { id: created.id },
    data: {
      phone,
      language: language ?? 'ar',
      ...(acquisition ? { acquisition: acquisition as unknown as Prisma.InputJsonValue } : {}),
    },
  });
  await tx.legalAcceptance.createMany({
    data: signupAcceptanceRows(created.id, request),
    skipDuplicates: true,
  });
});
```

`apps/admin/src/app/signup/page.tsx`:

```tsx
import { legalPolicyUrl } from '@ebda/shared';
```

State, next to `honeypot`:

```tsx
// Click-wrap (Ruling LEGAL-4): required; the API refuses a signup without it too.
const [agreed, setAgreed] = useState(false);
const [legalError, setLegalError] = useState(false);
```

In `handleSubmit`, replace the validation lines:

```tsx
const found = validateSignup(fields);
setErrors(found);
setLegalError(!agreed);
if (Object.keys(found).length > 0 || !agreed) return;
```

and add `acceptedLegal: true,` to the `apiPost` body right after `company_site: honeypot,`.

Insert above the submit `<Button>`:

```tsx
<div>
  <label htmlFor="signup-legal" className="flex items-start gap-2 text-sm text-foreground">
    <input
      id="signup-legal"
      name="acceptedLegal"
      type="checkbox"
      required
      checked={agreed}
      onChange={e => {
        setAgreed(e.target.checked);
        setLegalError(false);
      }}
      aria-invalid={legalError || undefined}
      aria-describedby={legalError ? 'signup-legal-error' : undefined}
      className="mt-0.5 h-4 w-4 shrink-0"
    />
    <span>
      {t('legal.prefix')}
      <a
        href={legalPolicyUrl('terms', locale)}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary-ink underline"
      >
        {t('legal.terms')}
      </a>
      {t('legal.sep')}
      <a
        href={legalPolicyUrl('privacy', locale)}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary-ink underline"
      >
        {t('legal.privacy')}
      </a>
      {t('legal.sep')}
      <a
        href={legalPolicyUrl('merchant', locale)}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary-ink underline"
      >
        {t('legal.merchant')}
      </a>
      {t('legal.lastSep')}
      <a
        href={legalPolicyUrl('acceptableUse', locale)}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary-ink underline"
      >
        {t('legal.acceptableUse')}
      </a>
    </span>
  </label>
  {legalError && (
    <p id="signup-legal-error" role="alert" className="mt-1 text-sm text-destructive-ink">
      {tErr('legalRequired')}
    </p>
  )}
</div>
```

i18n, `en.json` under `onboarding.signup`:

```json
      "legal": {
        "prefix": "I agree to the ",
        "terms": "Terms of Service",
        "privacy": "Privacy Policy",
        "merchant": "Merchant Agreement",
        "acceptableUse": "Acceptable Use Policy",
        "sep": ", ",
        "lastSep": " and the "
      },
```

and under `onboarding.signup.errors`: `"legalRequired": "You need to accept the terms and policies to create an account."`

`ar.json` under `onboarding.signup`:

```json
      "legal": {
        "prefix": "أوافق على ",
        "terms": "الشروط",
        "privacy": "سياسة الخصوصية",
        "merchant": "اتفاقية التاجر",
        "acceptableUse": "سياسة الاستخدام المقبول",
        "sep": " و",
        "lastSep": " و"
      },
```

and under `onboarding.signup.errors`: `"legalRequired": "لازم توافق على الشروط والسياسات علشان تعمل الحساب."`

(The Arabic renders exactly "أوافق على الشروط وسياسة الخصوصية واتفاقية التاجر وسياسة الاستخدام المقبول".)

Callers that must send the new field. Add `acceptedLegal: true` to each request body:

- `tests/integration/self-serve-onboarding.test.ts`, in `signup()`'s `.send({...})`, after `formToken`.
- `tests/integration/self-serve-onboarding-live.test.ts:100`, in the `call('POST', '/auth/merchant/signup', {...})` body.
- `tests/integration/store-creation-tenant-guard.test.ts:112`, in the `.send({...})` body.
- `tests/integration/merchant-password-reset.test.ts:73`, in the `.send({...})` body.
- `tests/integration/merchant-signup-abuse.test.ts`, in the `body()` helper's returned object.
- `scripts/ebda-e2e-self-serve.mjs:117`, in the signup body.
- `tests/unit/ebda-ads-signup-persist.test.ts`: in `base`, add `acceptedLegal: true as const`; in the `withUser` mock's fake `tx`, add `legalAcceptance: { createMany: async () => ({ count: 5 }) },`.
- `tests/unit/merchant-signup-phone.test.ts`: add `acceptedLegal: true` to its `base`.

`apps/admin/src/app/signup/page.test.tsx`: replace the `submit` helper so every existing submit ticks the box first, add the field to the exact-body assertion, and add one test:

```tsx
const submit = (opts: { agree?: boolean } = {}) => {
  const box = screen.getByRole('checkbox') as HTMLInputElement;
  if ((opts.agree ?? true) && !box.checked) fireEvent.click(box);
  fireEvent.click(screen.getByRole('button', { name: 'onboarding.signup.submit' }));
};
```

In `toHaveBeenCalledWith('/api/v1/auth/merchant/signup', {...})` add `acceptedLegal: true,` after `company_site: '',`.

```tsx
it('blocks submit until the policies are accepted, and links each policy on ebda.app', async () => {
  render(<SignupPage />);
  fill({ name: 'Mona', email: 'mona@x.com', phone: '01012345678', password: 'Str0ng!Passw0rd' });
  submit({ agree: false });
  expect(await screen.findByText('onboarding.signup.errors.legalRequired')).toBeTruthy();
  expect(apiPost).not.toHaveBeenCalled();
  const hrefs = screen.getAllByRole('link').map(a => a.getAttribute('href'));
  expect(hrefs).toEqual(
    expect.arrayContaining([
      'https://ebda.app/en/terms/',
      'https://ebda.app/en/privacy/',
      'https://ebda.app/en/merchant-agreement/',
      'https://ebda.app/en/acceptable-use/',
    ])
  );
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npx vitest run tests/unit/merchant-signup-legal.test.ts tests/unit/ebda-ads-signup-persist.test.ts tests/unit/merchant-signup-phone.test.ts apps/admin/src/app/signup/page.test.tsx tests/unit/admin-i18n-key-parity.test.ts tests/unit/admin-i18n-no-hardcoded-strings.test.ts
npx vitest run tests/integration/legal-signup-acceptance.test.ts tests/integration/self-serve-onboarding.test.ts tests/integration/merchant-signup-abuse.test.ts tests/integration/store-creation-tenant-guard.test.ts tests/integration/merchant-password-reset.test.ts --retry=1
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/legal-notice.service.ts apps/api/src/services/merchant-signup.service.ts apps/admin/src/app/signup/page.tsx apps/admin/src/app/signup/page.test.tsx apps/admin/src/i18n/messages/en.json apps/admin/src/i18n/messages/ar.json tests/unit/merchant-signup-legal.test.ts tests/unit/ebda-ads-signup-persist.test.ts tests/unit/merchant-signup-phone.test.ts tests/integration/legal-signup-acceptance.test.ts tests/integration/self-serve-onboarding.test.ts tests/integration/self-serve-onboarding-live.test.ts tests/integration/store-creation-tenant-guard.test.ts tests/integration/merchant-password-reset.test.ts tests/integration/merchant-signup-abuse.test.ts scripts/ebda-e2e-self-serve.mjs
git commit -m "feat(signup): required policy click-wrap recorded per document version"
```

---

### Task 5: Pending-notice API (`GET /me/legal-notices`, `POST /me/legal-notices/ack`)

**Files:**

- Modify: `apps/api/src/services/legal-notice.service.ts` (append)
- Create: `apps/api/src/routes/legal-policy.routes.ts`
- Modify: `apps/api/src/routes/index.ts` (import + mount after `router.use('/auth/mfa', mfaRoutes);`)
- Test: `tests/integration/legal-notices.test.ts` (new)

**Interfaces:**

- Consumes: `computePendingNotices`, `LEGAL_DOC_KEYS`, `type PendingLegalNotice` (Task 1); `activeLegalPolicies`, `LEGAL_UA_MAX` (Task 4).
- Produces:
  - `pendingNoticesFor(userId: string, role: string): Promise<PendingLegalNotice[]>`
  - `ackItemsSchema` (Zod `{ items: {docKey, version}[] }`, 1..5 items)
  - `ackNotices(userId: string, role: string, items: Array<{docKey: string; version: string}>, request: {ip?: string; userAgent?: string}): Promise<{ acknowledged: number }>`
  - `meLegalNoticeRoutes` (Express Router) exported from `legal-policy.routes.ts`, mounted at `/api/v1/me/legal-notices`.

- [ ] **Step 1: Write the failing test**

`tests/integration/legal-notices.test.ts`:

```ts
/**
 * Pending policy notices over HTTP (Ruling LEGAL-4) on the strict-RLS `ebda_app` login.
 * Review Focus 1 (one ack clears every store) and 4 (forged / non-pending ack refused).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { createPrismaClient, runWithRequestDb, type AppPrismaClient } from '@ebda/database';
import { LEGAL_POLICIES, type LegalPolicies } from '@ebda/shared';
import { config } from '@api/config';
import { meLegalNoticeRoutes } from '@api/routes/legal-policy.routes';
import { errorHandler } from '@api/middleware/error-handler';
import { awaitDeferredWork } from '@api/lib/after-tenant-commit';
import { __setLegalPoliciesForTests } from '@api/services/legal-notice.service';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const APP_PASSWORD = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
const hasDb = !!OWNER_URL && !OWNER_URL.includes('localhost:5432/test_db');
const run = crypto.randomUUID().slice(0, 8);
const V = '99.0';

const FIXTURE: LegalPolicies = {
  ...LEGAL_POLICIES,
  terms: {
    history: [
      ...LEGAL_POLICIES.terms.history,
      {
        version: V,
        publishedAt: '2026-10-20',
        effectiveAt: '2026-11-20',
        material: true,
        feeChange: true,
        summary: { ar: 'تغيير تجريبي في الرسوم.', en: 'Test fee change.' },
      },
    ],
  },
};

function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = APP_PASSWORD;
  return u.toString();
}
const asApp = <T>(fn: () => Promise<T>) =>
  runWithRequestDb(() => createPrismaClient({ connectionString: appUrl(), max: 3 }), fn, {
    beforeDisconnect: () => awaitDeferredWork(5000),
  });
const token = (userId: string, role: 'store_admin' | 'super_admin') =>
  jwt.sign({ userId, email: `${userId}@example.test`, role, tv: 0 }, config.jwtSecret, {
    expiresIn: '30m',
    issuer: 'ebda-api',
    audience: 'ebda-app',
  });

describe.skipIf(!hasDb)('pending legal notices', () => {
  let owner: AppPrismaClient;
  let app: Express;
  let merchant = '';
  let operator = '';
  const storeIds: string[] = [];

  const mkUser = async (tag: string, role: 'store_admin' | 'super_admin') =>
    (
      await owner.user.create({
        data: {
          email: `ln-${tag}-${run}-${crypto.randomUUID().slice(0, 6)}@test.local`,
          passwordHash: 'x',
          firstName: 'Ln',
          lastName: tag,
          role,
          emailVerified: true,
        },
      })
    ).id;
  const get = (userId: string, role: 'store_admin' | 'super_admin' = 'store_admin') =>
    asApp(async () =>
      request(app)
        .get('/api/v1/me/legal-notices')
        .set('Authorization', `Bearer ${token(userId, role)}`)
    );
  const ack = (
    userId: string,
    items: unknown,
    role: 'store_admin' | 'super_admin' = 'store_admin'
  ) =>
    asApp(async () =>
      request(app)
        .post('/api/v1/me/legal-notices/ack')
        .set('Authorization', `Bearer ${token(userId, role)}`)
        .send({ items })
    );
  const wipe = async () => {
    await owner.legalNoticeSend.deleteMany({ where: { docKey: 'terms', version: V } });
    await owner.legalAcceptance.deleteMany({ where: { docKey: 'terms', version: V } });
  };

  beforeAll(async () => {
    owner = createPrismaClient({ connectionString: OWNER_URL, max: 2, role: 'owner' });
    __setLegalPoliciesForTests(FIXTURE);
    app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use('/api/v1/me/legal-notices', meLegalNoticeRoutes);
    app.use(errorHandler);
    merchant = await mkUser('m', 'store_admin');
    operator = await mkUser('op', 'super_admin');
    for (const n of [1, 2]) {
      const s = await owner.store.create({
        data: {
          name: `ln-${run}-${n}`,
          slug: `ln-${run}-${n}`,
          ownerId: merchant,
          status: 'active',
        },
      });
      storeIds.push(s.id);
    }
  });
  beforeEach(wipe);
  afterAll(async () => {
    await wipe();
    __setLegalPoliciesForTests(null);
    await owner.store.deleteMany({ where: { id: { in: storeIds } } });
    await owner.user.deleteMany({ where: { id: { in: [merchant, operator] } } });
    await owner.$disconnect();
  });

  it('nothing is pending before the version is sent; the read is never cached', async () => {
    const res = await get(merchant);
    expect(res.status).toBe(200);
    expect(res.body.data.notices).toEqual([]);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('after a send the merchant has one pending notice with summary, date and links', async () => {
    await owner.legalNoticeSend.create({ data: { docKey: 'terms', version: V, sentBy: operator } });
    const res = await get(merchant);
    expect(res.body.data.notices).toEqual([
      {
        docKey: 'terms',
        version: V,
        effectiveAt: '2026-11-20',
        summary: { ar: 'تغيير تجريبي في الرسوم.', en: 'Test fee change.' },
        title: { ar: 'شروط الخدمة', en: 'Terms of service' },
        url: { ar: 'https://ebda.app/terms/', en: 'https://ebda.app/en/terms/' },
      },
    ]);
    // A super_admin is not a party to the merchant agreement: nothing pending, no 403.
    expect((await get(operator, 'super_admin')).body.data.notices).toEqual([]);
  });

  it('refuses an ack for a non-pending or forged version and writes nothing', async () => {
    await owner.legalNoticeSend.create({ data: { docKey: 'terms', version: V, sentBy: operator } });
    for (const items of [
      [{ docKey: 'terms', version: '1.0' }], // superseded
      [{ docKey: 'privacy', version: '1.0' }], // not material, never sent
      [{ docKey: 'terms', version: '98.0' }], // does not exist
      [{ docKey: 'cookies', version: V }], // unknown document
      [
        { docKey: 'terms', version: V },
        { docKey: 'privacy', version: '1.0' },
      ], // one bad item refuses the whole request
    ]) {
      const res = await ack(merchant, items);
      expect(res.status, JSON.stringify(items)).toBe(422);
      expect(res.body.error.code).toBe('NOT_PENDING');
    }
    expect(
      await owner.legalAcceptance.count({
        where: { userId: merchant, docKey: 'terms', version: V },
      })
    ).toBe(0);
    expect((await ack(merchant, [])).status).toBe(400);
    expect((await ack(operator, [{ docKey: 'terms', version: V }], 'super_admin')).status).toBe(
      403
    );
  });

  it('one ack clears the notice for every store the merchant owns; a repeat ack is a no-op', async () => {
    await owner.legalNoticeSend.create({ data: { docKey: 'terms', version: V, sentBy: operator } });
    const res = await ack(merchant, [{ docKey: 'terms', version: V }]);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ acknowledged: 1 });
    const rows = await owner.legalAcceptance.findMany({
      where: { userId: merchant, docKey: 'terms', version: V },
      select: { source: true },
    });
    expect(rows).toEqual([{ source: 'notice_ack' }]);
    // The notice is per user, not per store: no store of theirs shows it any more.
    expect((await get(merchant)).body.data.notices).toEqual([]);
    const again = await ack(merchant, [{ docKey: 'terms', version: V }]);
    expect(again.status).toBe(200);
    expect(again.body.data).toEqual({ acknowledged: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (Test environment exported): `npx vitest run tests/integration/legal-notices.test.ts --retry=1`
Expected: FAIL, `Failed to resolve import "@api/routes/legal-policy.routes"`.

- [ ] **Step 3: Write the implementation**

Append to `apps/api/src/services/legal-notice.service.ts` (merge the imports into the existing import block at the top):

```ts
import { z } from 'zod';
import { withUser } from '@ebda/database';
import { computePendingNotices, type LegalDocRef, type PendingLegalNotice } from '@ebda/shared';
import { AppError } from '../middleware/error-handler';

/** Only the merchant account (store owner) is a party to the merchant documents. */
const NOTICE_ROLE = 'store_admin';

export const ackItemsSchema = z
  .object({
    items: z
      .array(z.object({ docKey: z.string().max(40), version: z.string().max(20) }).strict())
      .min(1)
      .max(LEGAL_DOC_KEYS.length),
  })
  .strict();

async function sentAndAccepted(
  tx: Parameters<Parameters<typeof withUser>[1]>[0],
  userId: string
): Promise<{ sent: LegalDocRef[]; accepted: LegalDocRef[] }> {
  const sent = await tx.legalNoticeSend.findMany({ select: { docKey: true, version: true } });
  const accepted = await tx.legalAcceptance.findMany({
    where: { userId },
    select: { docKey: true, version: true },
  });
  return { sent, accepted };
}

/** Notices this user still has to see. Computed live, never cached (NEVER-stale). */
export async function pendingNoticesFor(
  userId: string,
  role: string
): Promise<PendingLegalNotice[]> {
  if (role !== NOTICE_ROLE) return [];
  return withUser(userId, async tx => {
    const { sent, accepted } = await sentAndAccepted(tx, userId);
    return computePendingNotices(activePolicies, sent, accepted);
  });
}

/**
 * Record "Got it" for the given notices. Every item must be pending for this user, or
 * already acknowledged by them (a double click is harmless); anything else is refused
 * whole with 422 NOT_PENDING and nothing is written.
 */
export async function ackNotices(
  userId: string,
  role: string,
  items: Array<{ docKey: string; version: string }>,
  request: { ip?: string; userAgent?: string }
): Promise<{ acknowledged: number }> {
  if (role !== NOTICE_ROLE) {
    throw new AppError(403, 'FORBIDDEN', 'Only a store owner acknowledges policy notices');
  }
  return withUser(userId, async tx => {
    const { sent, accepted } = await sentAndAccepted(tx, userId);
    const pending = computePendingNotices(activePolicies, sent, accepted);
    const match = (list: ReadonlyArray<LegalDocRef>, i: LegalDocRef) =>
      list.some(r => r.docKey === i.docKey && r.version === i.version);
    const bad = items.filter(i => !match(pending, i) && !match(accepted, i));
    if (bad.length > 0) {
      throw new AppError(422, 'NOT_PENDING', 'These notices are not pending for this account', {
        items: bad,
      });
    }
    const now = new Date();
    const fresh = items.filter(i => match(pending, i));
    if (fresh.length === 0) return { acknowledged: 0 };
    const r = await tx.legalAcceptance.createMany({
      data: fresh.map(i => ({
        userId,
        docKey: i.docKey,
        version: i.version,
        acceptedAt: now,
        ip: request.ip ?? null,
        userAgent: request.userAgent ? request.userAgent.slice(0, LEGAL_UA_MAX) : null,
        source: 'notice_ack',
      })),
      skipDuplicates: true,
    });
    return { acknowledged: r.count };
  });
}
```

`apps/api/src/routes/legal-policy.routes.ts`:

```ts
import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import { writeLimiter } from '../middleware/security';
import { parseInput } from '../lib/parse-input';
import { ackItemsSchema, ackNotices, pendingNoticesFor } from '../services/legal-notice.service';

/**
 * Legal policy notices (Ruling LEGAL-4).
 *
 *  Merchant (mounted at /me/legal-notices):
 *    GET  /      the signed-in user's pending material-change notices (never cached)
 *    POST /ack   { items: [{ docKey, version }] } -> records "Got it" (source notice_ack)
 *
 * User-level, not store-level: no storeId, no tenantContext. Each handler opens its own
 * user-scoped transaction (`withUser`) in the service.
 */
export const meLegalNoticeRoutes = Router();

meLegalNoticeRoutes.get(
  '/',
  authenticate,
  authorize('store_admin', 'staff', 'super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const notices = await pendingNoticesFor(req.user!.userId, req.user!.role);
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, data: { notices } });
    } catch (error) {
      next(error);
    }
  }
);

meLegalNoticeRoutes.post(
  '/ack',
  authenticate,
  authorize('store_admin', 'staff', 'super_admin'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { items } = parseInput(ackItemsSchema, req.body);
      const data = await ackNotices(req.user!.userId, req.user!.role, items, {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);
```

(`authorize` admits all three admin roles so a non-owner gets the service's precise 403 rather than a generic one.)

`apps/api/src/routes/index.ts`: import and mount:

```ts
import { meLegalNoticeRoutes } from './legal-policy.routes';
```

```ts
// Legal policy notices for the signed-in merchant (Ruling LEGAL-4): user-level, no store scope.
router.use('/me/legal-notices', meLegalNoticeRoutes);
```

(Place the mount directly after `router.use('/auth/mfa', mfaRoutes);`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration/legal-notices.test.ts --retry=1 && tsc --noEmit -p apps/api/tsconfig.json`
Expected: PASS; tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/legal-notice.service.ts apps/api/src/routes/legal-policy.routes.ts apps/api/src/routes/index.ts tests/integration/legal-notices.test.ts
git commit -m "feat(api): pending legal notices and got-it acknowledgement"
```

---

### Task 6: Dashboard banner next to `BillingStatusBanner`

**Files:**

- Create: `apps/admin/src/components/legal/LegalNoticeBanner.tsx`
- Create: `apps/admin/src/components/legal/LegalNoticeBanner.test.tsx`
- Modify: `apps/admin/src/app/stores/[id]/layout.tsx` (import + mount after `BillingStatusBanner`)
- Modify: `apps/admin/src/i18n/messages/en.json`, `ar.json` (new top-level `legalNotice`)

**Interfaces:**

- Consumes: `GET /api/v1/me/legal-notices` → `{ notices: PendingLegalNotice[] }`; `POST /api/v1/me/legal-notices/ack` (Task 5); `formatLegalDate`, `type PendingLegalNotice` (Task 1).
- Produces: `LegalNoticeBanner({ storeId }: { storeId: string })`.

- [ ] **Step 1: Write the failing test**

`apps/admin/src/components/legal/LegalNoticeBanner.test.tsx`:

```tsx
// @vitest-environment jsdom
/**
 * Policy-change banner (Ruling LEGAL-4): one banner for every pending notice, Latin digits,
 * one "Got it" acknowledges all of them, never blocks the page.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('../../lib/api', () => ({ apiGet, apiPost }));
vi.mock('next-intl', () => ({ useLocale: () => 'ar' }));
vi.mock('../../i18n/useT', () => {
  const t = (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key;
  return { useT: () => t };
});

import { LegalNoticeBanner } from './LegalNoticeBanner';

const notice = (docKey: string, ar: string) => ({
  docKey,
  version: '1.1',
  effectiveAt: '2026-11-20',
  summary: { ar, en: `${docKey} changed` },
  title: { ar: `عنوان ${docKey}`, en: docKey },
  url: { ar: `https://ebda.app/${docKey}/`, en: `https://ebda.app/en/${docKey}/` },
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('LegalNoticeBanner', () => {
  it('renders nothing when nothing is pending', async () => {
    apiGet.mockResolvedValue({ data: { notices: [] }, error: null });
    const { container } = render(<LegalNoticeBanner storeId="s1" />);
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/api/v1/me/legal-notices'));
    expect(container.textContent).toBe('');
  });

  it('lists every pending notice in ONE banner, in Arabic, with Latin digits and policy links', async () => {
    apiGet.mockResolvedValue({
      data: { notices: [notice('terms', 'تغيير في الرسوم.'), notice('privacy', 'مزوّد جديد.')] },
      error: null,
    });
    render(<LegalNoticeBanner storeId="s1" />);
    const banner = await screen.findByRole('status');
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(banner.textContent).toContain('تغيير في الرسوم.');
    expect(banner.textContent).toContain('مزوّد جديد.');
    expect(banner.textContent).toContain('20 نوفمبر 2026');
    expect(banner.textContent).not.toMatch(/[٠-٩]/);
    expect(screen.getAllByRole('link').map(a => a.getAttribute('href'))).toEqual([
      'https://ebda.app/terms/',
      'https://ebda.app/privacy/',
    ]);
  });

  it('one "Got it" acknowledges all shown notices, once, then hides', async () => {
    apiGet.mockResolvedValue({
      data: { notices: [notice('terms', 'أ'), notice('privacy', 'ب')] },
      error: null,
    });
    apiPost.mockResolvedValue({ data: { acknowledged: 2 }, error: null });
    const { container } = render(<LegalNoticeBanner storeId="s1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'gotIt' }));
    await waitFor(() => expect(container.textContent).toBe(''));
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(apiPost).toHaveBeenCalledWith('/api/v1/me/legal-notices/ack', {
      items: [
        { docKey: 'terms', version: '1.1' },
        { docKey: 'privacy', version: '1.1' },
      ],
    });
  });

  it('a failed ack keeps the banner and says so', async () => {
    apiGet.mockResolvedValue({ data: { notices: [notice('terms', 'أ')] }, error: null });
    apiPost.mockResolvedValue({ data: null, error: { status: 500, code: 'X', message: 'x' } });
    render(<LegalNoticeBanner storeId="s1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'gotIt' }));
    expect((await screen.findByRole('alert')).textContent).toBe('ackFailed');
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('re-reads when the store changes (a notice acked in another store is gone there too)', async () => {
    apiGet.mockResolvedValue({ data: { notices: [] }, error: null });
    const { rerender } = render(<LegalNoticeBanner storeId="s1" />);
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    rerender(<LegalNoticeBanner storeId="s2" />);
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/admin/src/components/legal/LegalNoticeBanner.test.tsx`
Expected: FAIL, `Failed to resolve import "./LegalNoticeBanner"`.

- [ ] **Step 3: Write the implementation**

`apps/admin/src/components/legal/LegalNoticeBanner.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { formatLegalDate, type PendingLegalNotice } from '@ebda/shared';
import { apiGet, apiPost } from '../../lib/api';
import { useT } from '../../i18n/useT';

/**
 * Material policy-change notice (Ruling LEGAL-4). Shown on every store page, next to the
 * billing banner, while the signed-in merchant has a sent, unacknowledged material version.
 * Non-blocking: the page works underneath it. One "Got it" acknowledges every listed notice.
 * Notices are per USER, so acknowledging in one store clears it in all of them; `storeId`
 * only re-triggers the read when the merchant switches store.
 */
export function LegalNoticeBanner({ storeId }: { storeId: string }) {
  const t = useT('legalNotice');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const [notices, setNotices] = useState<PendingLegalNotice[]>([]);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void apiGet<{ notices: PendingLegalNotice[] }>('/api/v1/me/legal-notices').then(({ data }) => {
      if (!cancelled) setNotices(data?.notices ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [storeId]);

  if (notices.length === 0) return null;

  const acknowledge = async () => {
    setSaving(true);
    setFailed(false);
    const { error } = await apiPost<{ acknowledged: number }>('/api/v1/me/legal-notices/ack', {
      items: notices.map(n => ({ docKey: n.docKey, version: n.version })),
    });
    setSaving(false);
    if (error) {
      setFailed(true);
      return;
    }
    setNotices([]);
  };

  return (
    <div
      role="status"
      aria-labelledby="legal-notice-title"
      className="flex flex-col gap-2 border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200 lg:ms-72"
    >
      <p id="legal-notice-title" className="font-medium">
        {t('title')}
      </p>
      <ul className="space-y-1">
        {notices.map(n => (
          <li key={`${n.docKey}@${n.version}`}>
            <span className="font-medium">{n.title[locale]}</span>
            {t('sep')}
            {n.summary[locale]} {t('effective', { date: formatLegalDate(n.effectiveAt, locale) })}{' '}
            <a href={n.url[locale]} target="_blank" rel="noopener noreferrer" className="underline">
              {t('read')}
            </a>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={acknowledge}
          disabled={saving}
          className="rounded-md bg-amber-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60 dark:bg-amber-200 dark:text-amber-950"
        >
          {saving ? t('saving') : t('gotIt')}
        </button>
        {failed && <span role="alert">{t('ackFailed')}</span>}
      </div>
    </div>
  );
}
```

`apps/admin/src/app/stores/[id]/layout.tsx`:

```tsx
import { LegalNoticeBanner } from '../../../components/legal/LegalNoticeBanner';
```

```tsx
<AdminFeatureProvider storeId={storeId}>
  {storeId && <BillingStatusBanner storeId={storeId} />}
  {storeId && <LegalNoticeBanner storeId={storeId} />}
  {children}
</AdminFeatureProvider>
```

`en.json` (top level, alphabetical neighbourhood is not enforced; place after `"looks"`):

```json
  "legalNotice": {
    "title": "We updated our policies",
    "sep": ": ",
    "effective": "Takes effect {date}.",
    "read": "Read the policy",
    "gotIt": "Got it",
    "saving": "Saving…",
    "ackFailed": "Could not save. Please try again."
  },
```

`ar.json`:

```json
  "legalNotice": {
    "title": "حدّثنا سياساتنا",
    "sep": ": ",
    "effective": "يسري من {date}.",
    "read": "اقرأ السياسة",
    "gotIt": "تمام، فهمت",
    "saving": "جارٍ الحفظ…",
    "ackFailed": "ماقدرناش نحفظ. جرّب تاني."
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/admin/src/components/legal/LegalNoticeBanner.test.tsx apps/admin/src/components/billing/BillingStatusBanner.test.tsx tests/unit/admin-i18n-key-parity.test.ts tests/unit/admin-i18n-keys-resolve.test.ts && tsc --noEmit -p apps/admin/tsconfig.json`
Expected: all PASS; tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/components/legal/LegalNoticeBanner.tsx apps/admin/src/components/legal/LegalNoticeBanner.test.tsx "apps/admin/src/app/stores/[id]/layout.tsx" apps/admin/src/i18n/messages/en.json apps/admin/src/i18n/messages/ar.json
git commit -m "feat(admin): non-blocking policy-change banner with got-it"
```

---

### Task 7: Email fan-out (template, mailer, idempotent Inngest function)

**Files:**

- Create: `apps/api/src/services/email-templates/legal-notice.ts`
- Modify: `apps/api/src/services/platform-mailer.ts` (add `sendLegalNoticeEmail`)
- Modify: `apps/api/src/services/legal-notice.service.ts` (append the fan-out)
- Create: `apps/api/src/lib/inngest/functions/legal-notice-send.ts`
- Modify: `apps/api/src/lib/inngest/client.ts` (event type + `AppEvent` union)
- Modify: `apps/api/src/lib/inngest/functions/index.ts` (import + register)
- Modify: `tests/unit/no-rls-bypass-in-runtime.test.ts` (`ALLOWED_PLATFORM_OPERATOR`)
- Test: `tests/unit/legal-notice-email.test.ts` (new), `tests/integration/legal-notice-fanout.test.ts` (new)

**Interfaces:**

- Consumes: `findLegalVersion`, `formatLegalDate`, `legalPolicyUrl`, `LEGAL_DOC_TITLE`, `isLegalDocKey` (Task 1); `activeLegalPolicies`/`activePolicies` (Task 4); `awaitCampaignSendSlot()` from `apps/api/src/lib/campaign-send-pacer.ts`; `asPlatformOperator`, `prisma` from `@ebda/database`.
- Produces:
  - `legalNoticeTemplate` + `interface LegalNoticeEmailData { name; title; summary; effectiveOn; url }`
  - `sendLegalNoticeEmail(data: LegalNoticeEmailData & { email: string }, language: 'ar' | 'en'): Promise<void>`
  - `LEGAL_NOTICE_BATCH_SIZE = 20`
  - `listNoticeRecipients(operatorId: string): Promise<string[]>`
  - `materializeDeliveries(operatorId, docKey, version): Promise<{ ok: true; recipientCount: number } | { ok: false; reason: string }>`
  - `sendNextBatch(operatorId, docKey, version, size?): Promise<{ sent: number; failed: number; remaining: number }>`
  - `failQueuedDeliveries(operatorId, docKey, version, reason): Promise<number>`
  - `runLegalNoticeSend({ event, step })` and `legalNoticeSend` (Inngest function id `legal-notice-send`, event `legal/notice.send-requested`, data `{ docKey, version, sentBy }`)

**Recipient query (exact):** every user who owns a store with `stores.deleted_at IS NULL AND stores.is_demo = false`, whose `users.role = 'store_admin'` and `users.deleted_at IS NULL`, deduplicated by user id (`SELECT DISTINCT u.id FROM stores s JOIN users u ON u.id = s.owner_id WHERE s.deleted_at IS NULL AND NOT s.is_demo AND u.role = 'store_admin' AND u.deleted_at IS NULL`). It runs through Prisma as the operator who pressed send (`asPlatformOperator`).

- [ ] **Step 1: Write the failing tests**

`tests/unit/legal-notice-email.test.ts`:

```ts
/** The legal-notice email (Ruling LEGAL-4): bilingual, Latin digits, link, no unsubscribe. */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  sendLegalNoticeEmail,
  clearCapturedMail,
  latestCapturedMailTo,
} from '@api/services/platform-mailer';

const data = {
  email: 'm@test.local',
  name: 'Mona <b>',
  title: 'شروط الخدمة',
  summary: 'تغيير في الرسوم.',
  effectiveOn: '20 نوفمبر 2026',
  url: 'https://ebda.app/terms/',
};

beforeEach(() => clearCapturedMail());

describe('sendLegalNoticeEmail', () => {
  it('Arabic: subject names the document, body has summary, date, link, no unsubscribe', async () => {
    await sendLegalNoticeEmail(data, 'ar');
    const mail = latestCapturedMailTo('m@test.local')!;
    expect(mail.subject).toContain('شروط الخدمة');
    expect(mail.html).toContain('تغيير في الرسوم.');
    expect(mail.html).toContain('20 نوفمبر 2026');
    expect(mail.link).toBe('https://ebda.app/terms/');
    expect(mail.html).not.toMatch(/[٠-٩]/);
    expect(mail.html).not.toMatch(/unsubscribe|إلغاء الاشتراك/i);
    expect(mail.html).toContain('Mona &lt;b&gt;');
    expect(mail.replyTo).toBe('ahlan@ebda.app');
  });
  it('English', async () => {
    await sendLegalNoticeEmail(
      {
        ...data,
        title: 'Terms of service',
        summary: 'Fee change.',
        effectiveOn: '20 November 2026',
        url: 'https://ebda.app/en/terms/',
      },
      'en'
    );
    const mail = latestCapturedMailTo('m@test.local')!;
    expect(mail.subject).toBe('We updated our Terms of service');
    expect(mail.html).toContain('20 November 2026');
    expect(mail.link).toBe('https://ebda.app/en/terms/');
  });
});
```

`tests/integration/legal-notice-fanout.test.ts`:

```ts
/**
 * The legal-notice email fan-out (Ruling LEGAL-4), run through the real handler on the
 * strict-RLS `ebda_app` login with a step shim that memoizes like Inngest.
 * Review Focus 1 (two stores -> one email) and 2 (a retry never double-sends).
 * The mail function is mocked only to COUNT sends per address; the template is covered by
 * tests/unit/legal-notice-email.test.ts.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import { createPrismaClient, runWithRequestDb, type AppPrismaClient } from '@ebda/database';
import { LEGAL_POLICIES, type LegalPolicies } from '@ebda/shared';

const { sendLegalNoticeEmail } = vi.hoisted(() => ({
  sendLegalNoticeEmail: vi.fn(async (_d: { email: string }, _l: string) => undefined),
}));
vi.mock('@api/services/platform-mailer', async orig => ({
  ...(await orig<typeof import('@api/services/platform-mailer')>()),
  sendLegalNoticeEmail,
}));

import { runLegalNoticeSend } from '@api/lib/inngest/functions/legal-notice-send';
import { __setLegalPoliciesForTests } from '@api/services/legal-notice.service';
import { awaitDeferredWork } from '@api/lib/after-tenant-commit';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const APP_PASSWORD = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
const hasDb = !!OWNER_URL && !OWNER_URL.includes('localhost:5432/test_db');
const run = crypto.randomUUID().slice(0, 8);
const V = '99.0';
const FIXTURE: LegalPolicies = {
  ...LEGAL_POLICIES,
  terms: {
    history: [
      ...LEGAL_POLICIES.terms.history,
      {
        version: V,
        publishedAt: '2026-10-20',
        effectiveAt: '2026-11-20',
        material: true,
        feeChange: true,
        summary: { ar: 'تغيير تجريبي في الرسوم.', en: 'Test fee change.' },
      },
    ],
  },
};

function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = APP_PASSWORD;
  return u.toString();
}
const asApp = <T>(fn: () => Promise<T>) =>
  runWithRequestDb(() => createPrismaClient({ connectionString: appUrl(), max: 3 }), fn, {
    beforeDisconnect: () => awaitDeferredWork(5000),
  });

function makeStep(memo: Map<string, unknown>) {
  return {
    run: async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
      if (memo.has(id)) return memo.get(id) as T;
      const value = await fn();
      const serialized = value === undefined ? null : JSON.parse(JSON.stringify(value));
      memo.set(id, serialized);
      return serialized as T;
    },
  };
}

describe.skipIf(!hasDb)('legal notice email fan-out', () => {
  let owner: AppPrismaClient;
  const ids = { two: '', deletedOnly: '', noStore: '', en: '', op: '' };
  const emails: Record<string, string> = {};
  const storeIds: string[] = [];
  process.env.CAMPAIGN_PLATFORM_SEND_INTERVAL_MS = '0';

  const mkUser = async (tag: string, role: 'store_admin' | 'super_admin', language = 'ar') => {
    const email = `lnf-${tag}-${run}-${crypto.randomUUID().slice(0, 6)}@test.local`;
    const u = await owner.user.create({
      data: {
        email,
        passwordHash: 'x',
        firstName: 'Lnf',
        lastName: tag,
        role,
        emailVerified: true,
        language,
      },
    });
    emails[u.id] = email;
    return u.id;
  };
  const mkStore = async (ownerId: string, n: number, deleted = false) => {
    const s = await owner.store.create({
      data: {
        name: `lnf-${run}-${n}`,
        slug: `lnf-${run}-${n}`,
        ownerId,
        status: 'active',
        ...(deleted ? { deletedAt: new Date() } : {}),
      },
    });
    storeIds.push(s.id);
  };
  const sendsTo = (userId: string) =>
    sendLegalNoticeEmail.mock.calls.filter(c => c[0].email === emails[userId]).length;
  const runJob = () =>
    asApp(() =>
      runLegalNoticeSend({
        event: { data: { docKey: 'terms', version: V, sentBy: ids.op } },
        step: makeStep(new Map()),
      })
    );
  const wipe = async () => {
    await owner.legalNoticeDelivery.deleteMany({ where: { docKey: 'terms', version: V } });
    await owner.legalNoticeSend.deleteMany({ where: { docKey: 'terms', version: V } });
  };

  beforeAll(async () => {
    owner = createPrismaClient({ connectionString: OWNER_URL, max: 2, role: 'owner' });
    __setLegalPoliciesForTests(FIXTURE);
    ids.two = await mkUser('two', 'store_admin');
    ids.deletedOnly = await mkUser('deleted', 'store_admin');
    ids.noStore = await mkUser('nostore', 'store_admin');
    ids.en = await mkUser('en', 'store_admin', 'en');
    ids.op = await mkUser('op', 'super_admin');
    await mkStore(ids.two, 1);
    await mkStore(ids.two, 2);
    await mkStore(ids.deletedOnly, 3, true);
    await mkStore(ids.en, 4);
  });
  beforeEach(async () => {
    await wipe();
    sendLegalNoticeEmail.mockClear();
    await owner.legalNoticeSend.create({ data: { docKey: 'terms', version: V, sentBy: ids.op } });
  });
  afterAll(async () => {
    await wipe();
    __setLegalPoliciesForTests(null);
    await owner.store.deleteMany({ where: { id: { in: storeIds } } });
    await owner.user.deleteMany({ where: { id: { in: Object.values(ids) } } });
    await owner.$disconnect();
  });

  it('two stores, one email; deleted-store and store-less accounts get none; language honoured', async () => {
    const result = await runJob();
    expect(sendsTo(ids.two)).toBe(1);
    expect(sendsTo(ids.deletedOnly)).toBe(0);
    expect(sendsTo(ids.noStore)).toBe(0);
    expect(sendsTo(ids.en)).toBe(1);
    const two = sendLegalNoticeEmail.mock.calls.find(c => c[0].email === emails[ids.two])!;
    expect(two[1]).toBe('ar');
    expect(two[0]).toMatchObject({
      title: 'شروط الخدمة',
      summary: 'تغيير تجريبي في الرسوم.',
      effectiveOn: '20 نوفمبر 2026',
      url: 'https://ebda.app/terms/',
    });
    const en = sendLegalNoticeEmail.mock.calls.find(c => c[0].email === emails[ids.en])!;
    expect(en[1]).toBe('en');
    const rows = await owner.legalNoticeDelivery.findMany({
      where: {
        docKey: 'terms',
        version: V,
        userId: { in: [ids.two, ids.deletedOnly, ids.noStore] },
      },
      select: { userId: true, status: true },
    });
    expect(rows).toEqual([{ userId: ids.two, status: 'sent' }]);
    const send = await owner.legalNoticeSend.findUnique({
      where: { docKey_version: { docKey: 'terms', version: V } },
    });
    expect(send?.recipientCount).toBe(result.recipientCount);
  }, 120_000);

  it('a re-run (retry with a fresh memo) sends nothing new', async () => {
    await runJob();
    const first = sendLegalNoticeEmail.mock.calls.length;
    await runJob();
    expect(sendLegalNoticeEmail.mock.calls.length).toBe(first);
    expect(sendsTo(ids.two)).toBe(1);
  }, 120_000);

  it('a row stuck in `sending` (crash after the mail went out) is never re-sent', async () => {
    await owner.legalNoticeDelivery.create({
      data: { userId: ids.two, docKey: 'terms', version: V, status: 'sending' },
    });
    await runJob();
    expect(sendsTo(ids.two)).toBe(0);
    expect(sendsTo(ids.en)).toBe(1);
  }, 120_000);

  it('a failed send marks the row failed with the error, and the run goes on', async () => {
    sendLegalNoticeEmail.mockImplementation(async d => {
      if (d.email === emails[ids.en]) throw new Error('Resend send failed: boom');
    });
    await runJob();
    const row = await owner.legalNoticeDelivery.findUnique({
      where: { userId_docKey_version: { userId: ids.en, docKey: 'terms', version: V } },
    });
    expect(row).toMatchObject({ status: 'failed', error: 'Resend send failed: boom' });
    expect(sendsTo(ids.two)).toBe(1);
    sendLegalNoticeEmail.mockImplementation(async () => undefined);
  }, 120_000);

  it('skips when the send row is gone (the request was compensated)', async () => {
    await wipe();
    expect(await runJob()).toEqual({ skipped: 'SEND_ROW_MISSING' });
    expect(sendLegalNoticeEmail).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/legal-notice-email.test.ts` and (Test environment) `npx vitest run tests/integration/legal-notice-fanout.test.ts --retry=1`
Expected: FAIL, `sendLegalNoticeEmail is not a function` / `Failed to resolve import "@api/lib/inngest/functions/legal-notice-send"`.

- [ ] **Step 3: Write the implementation**

`apps/api/src/services/email-templates/legal-notice.ts`:

```ts
import { BRAND } from '@ebda/shared';
import { escapeHtml } from './_util';

/**
 * Material policy-change notice (Ruling LEGAL-4). A service/legal notice to every store
 * owner, NOT marketing: it carries no unsubscribe link, by design (documented in the ruling
 * and in the email's own footer line).
 */
export interface LegalNoticeEmailData {
  name: string;
  /** Document title in the mail's language. */
  title: string;
  /** What changed, in the mail's language. */
  summary: string;
  /** Effective date, already formatted with Latin digits (formatLegalDate). */
  effectiveOn: string;
  /** The policy page on ebda.app, in the mail's language. */
  url: string;
}

export const legalNoticeTemplate = {
  subject: {
    en: (d: LegalNoticeEmailData) => `We updated our ${d.title}`,
    ar: (d: LegalNoticeEmailData) => `حدّثنا ${d.title} في ${BRAND.product.nameAr}`,
  },

  en: (d: LegalNoticeEmailData) => `
    <h2>We updated our ${escapeHtml(d.title)}</h2>
    <p>Hi ${escapeHtml(d.name)},</p>
    <p>${escapeHtml(d.summary)}</p>
    <p>The new version takes effect on <strong>${escapeHtml(d.effectiveOn)}</strong>. Continuing to use ${escapeHtml(BRAND.product.nameEn)} after that date means you accept it; if you do not, you can close your account before then.</p>
    <p style="text-align:center;margin:24px 0;"><a href="${escapeHtml(d.url)}" class="button">Read the ${escapeHtml(d.title)}</a></p>
    <p style="font-size:14px;color:#666;">This is a service notice about your account. We send it to every merchant when a policy changes in a material way, so it has no unsubscribe link. Questions? Reply to this email.</p>
  `,

  ar: (d: LegalNoticeEmailData) => `
    <h2>حدّثنا ${escapeHtml(d.title)}</h2>
    <p>مرحباً ${escapeHtml(d.name)}،</p>
    <p>${escapeHtml(d.summary)}</p>
    <p>النسخة الجديدة تسري من <strong>${escapeHtml(d.effectiveOn)}</strong>. استمرارك في استخدام ${escapeHtml(BRAND.product.nameAr)} بعد التاريخ ده يعني موافقتك عليها؛ ولو مش موافق تقدر تقفل حسابك قبلها.</p>
    <p style="text-align:center;margin:24px 0;"><a href="${escapeHtml(d.url)}" class="button">اقرأ ${escapeHtml(d.title)}</a></p>
    <p style="font-size:14px;color:#666;">دي رسالة خدمة بخصوص حسابك. بنبعتها لكل التجار لما سياسة تتغير تغيير جوهري، علشان كده مافيهاش رابط لإلغاء الاشتراك. عندك سؤال؟ رد على الرسالة دي.</p>
  `,
};
```

`apps/api/src/services/platform-mailer.ts`: add the import and the sender at the end:

```ts
import { legalNoticeTemplate, type LegalNoticeEmailData } from './email-templates/legal-notice';
```

```ts
/**
 * Material policy-change notice to a store owner (Ruling LEGAL-4). Called once per recipient
 * by the `legal-notice-send` Inngest function, which owns idempotency (legal_notice_deliveries)
 * and throttling (the platform send pacer). Throws on a provider error so the caller marks
 * the delivery `failed`.
 */
export async function sendLegalNoticeEmail(
  data: LegalNoticeEmailData & { email: string },
  language: Lang
): Promise<void> {
  const content = legalNoticeTemplate[language](data);
  const html = renderBrandedShell(content, {
    name: BRAND.product.nameEn,
    nameAr: BRAND.product.nameAr,
    logo: BRAND_EMAIL_LOGO_URL,
    theme: null,
    email: null,
    phone: null,
    address: null,
    defaultLanguage: language,
  });
  await deliver({
    to: data.email,
    subject: legalNoticeTemplate.subject[language](data),
    html,
    replyTo: BRAND.supportEmail,
  });
}
```

Append to `apps/api/src/services/legal-notice.service.ts` (merge the imports into the top block):

```ts
import { asPlatformOperator, prisma } from '@ebda/database';
import {
  LEGAL_DOC_TITLE,
  findLegalVersion,
  formatLegalDate,
  isLegalDocKey,
  legalPolicyUrl,
} from '@ebda/shared';
import logger from '../lib/logger';
import { awaitCampaignSendSlot } from '../lib/campaign-send-pacer';
import { sendLegalNoticeEmail } from './platform-mailer';

/** Recipients per Inngest step: ~20 s at the default 1/s pacer, far inside the 100 s edge limit. */
export const LEGAL_NOTICE_BATCH_SIZE = 20;
const ERROR_MAX = 300;
type DeliveryStatus = 'queued' | 'sending' | 'sent' | 'failed';

/**
 * Who is notified: every OWNER of a store that is not soft-deleted and not a demo store,
 * whose account is a live merchant (role store_admin, not deleted). One id per user, so a
 * merchant with several stores is notified once. Read as the operator who pressed send.
 */
export async function listNoticeRecipients(operatorId: string): Promise<string[]> {
  return asPlatformOperator(operatorId, async () => {
    const stores = await prisma.store.findMany({
      where: { deletedAt: null, isDemo: false },
      select: { ownerId: true },
    });
    const ownerIds = [...new Set(stores.map(s => s.ownerId))];
    if (ownerIds.length === 0) return [];
    const users = await prisma.user.findMany({
      where: { id: { in: ownerIds }, role: 'store_admin', deletedAt: null },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return users.map(u => u.id);
  });
}

/**
 * One `queued` delivery row per recipient (skipDuplicates: re-running is a no-op for rows
 * that exist). Skips when the send row is gone: the request that emitted the event was
 * compensated after an enqueue failure.
 */
export async function materializeDeliveries(
  operatorId: string,
  docKey: string,
  version: string
): Promise<{ ok: true; recipientCount: number } | { ok: false; reason: string }> {
  const send = await prisma.legalNoticeSend.findUnique({
    where: { docKey_version: { docKey, version } },
    select: { id: true },
  });
  if (!send) return { ok: false, reason: 'SEND_ROW_MISSING' };
  const userIds = await listNoticeRecipients(operatorId);
  for (let i = 0; i < userIds.length; i += 500) {
    const slice = userIds.slice(i, i + 500);
    await asPlatformOperator(operatorId, () =>
      prisma.legalNoticeDelivery.createMany({
        data: slice.map(userId => ({ userId, docKey, version })),
        skipDuplicates: true,
      })
    );
  }
  await prisma.legalNoticeSend.update({
    where: { docKey_version: { docKey, version } },
    data: { recipientCount: userIds.length },
  });
  return { ok: true, recipientCount: userIds.length };
}

async function markDelivery(
  operatorId: string,
  userId: string,
  docKey: string,
  version: string,
  status: DeliveryStatus,
  error: string | null
): Promise<void> {
  await asPlatformOperator(operatorId, () =>
    prisma.legalNoticeDelivery.updateMany({
      where: { userId, docKey, version, status: 'sending' },
      data: { status, error },
    })
  );
}

/**
 * Mail up to `size` still-`queued` recipients. Each row is CLAIMED (queued -> sending) before
 * its mail goes out, so no retry, overlap or re-run can mail anyone twice; a crash between the
 * send and the final mark leaves the row in `sending`, which is never re-sent (Ruling LEGAL-5).
 * A send error marks the row `failed` and the batch goes on. Each DB call is its own short
 * transaction: nothing is held open across a mail send.
 */
export async function sendNextBatch(
  operatorId: string,
  docKey: string,
  version: string,
  size: number = LEGAL_NOTICE_BATCH_SIZE
): Promise<{ sent: number; failed: number; remaining: number }> {
  const entry = findLegalVersion(activePolicies, docKey, version);
  if (!entry || !isLegalDocKey(docKey)) {
    throw new Error(`legal notice: ${docKey}@${version} is not in LEGAL_POLICIES`);
  }
  const queued = await asPlatformOperator(operatorId, () =>
    prisma.legalNoticeDelivery.findMany({
      where: { docKey, version, status: 'queued' },
      orderBy: { userId: 'asc' },
      take: size,
      select: { userId: true },
    })
  );
  let sent = 0;
  let failed = 0;
  for (const { userId } of queued) {
    const claimed = await asPlatformOperator(operatorId, () =>
      prisma.legalNoticeDelivery.updateMany({
        where: { userId, docKey, version, status: 'queued' },
        data: { status: 'sending' },
      })
    );
    if (claimed.count !== 1) continue;
    const user = await asPlatformOperator(operatorId, () =>
      prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, firstName: true, language: true },
      })
    );
    const lang: 'ar' | 'en' = user?.language === 'en' ? 'en' : 'ar';
    let error: string | null = null;
    try {
      if (!user) throw new Error('USER_GONE');
      await awaitCampaignSendSlot();
      await sendLegalNoticeEmail(
        {
          email: user.email,
          name: user.firstName || user.email,
          title: LEGAL_DOC_TITLE[docKey][lang],
          summary: entry.summary[lang],
          effectiveOn: formatLegalDate(entry.effectiveAt, lang),
          url: legalPolicyUrl(docKey, lang),
        },
        lang
      );
    } catch (err) {
      error = String((err as Error)?.message ?? err).slice(0, ERROR_MAX);
      logger.warn({ err, userId, docKey, version }, '[LEGAL-NOTICE] send failed');
    }
    // Outside the try: if this mark throws, the step retries and the row stays `sending`
    // (never re-sent), instead of a delivered mail being recorded as failed.
    await markDelivery(operatorId, userId, docKey, version, error ? 'failed' : 'sent', error);
    if (error) failed++;
    else sent++;
  }
  const remaining = await asPlatformOperator(operatorId, () =>
    prisma.legalNoticeDelivery.count({ where: { docKey, version, status: 'queued' } })
  );
  return { sent, failed, remaining };
}

/** No orphan `queued` rows: the job's failure handler marks what it never reached. */
export async function failQueuedDeliveries(
  operatorId: string,
  docKey: string,
  version: string,
  reason: string
): Promise<number> {
  const r = await asPlatformOperator(operatorId, () =>
    prisma.legalNoticeDelivery.updateMany({
      where: { docKey, version, status: 'queued' },
      data: { status: 'failed', error: reason },
    })
  );
  return r.count;
}
```

`apps/api/src/lib/inngest/functions/legal-notice-send.ts`:

```ts
import { inngest } from '../client';
import logger from '../../logger';
import {
  LEGAL_NOTICE_BATCH_SIZE,
  failQueuedDeliveries,
  materializeDeliveries,
  sendNextBatch,
} from '../../../services/legal-notice.service';

/**
 * Material policy-change email fan-out (Ruling LEGAL-4). Triggered ONLY by
 * `legal/notice.send-requested`, which only the super-admin
 * `POST /admin/legal-policies/:docKey/:version/send-notice` emits.
 *
 * Invariants:
 *  - one email per recipient per version: delivery rows are UNIQUE(user, doc, version) and
 *    are claimed queued -> sending before the send (legal-notice.service.ts sendNextBatch);
 *  - throttled by the platform send pacer (shared Resend budget);
 *  - no orphan `queued` rows: onFailure marks the rest `failed`.
 */
type SendData = { docKey?: string; version?: string; sentBy?: string };
type StepLike = { run: <T>(id: string, fn: () => Promise<T>) => Promise<T> };

export async function runLegalNoticeSend({
  event,
  step,
}: {
  event: { data?: SendData };
  step: StepLike;
}) {
  const { docKey, version, sentBy } = event.data ?? {};
  if (!docKey || !version || !sentBy) {
    logger.warn('[LEGAL-NOTICE] send-requested without docKey/version/sentBy, skipping');
    return { skipped: 'missing-data' };
  }
  const m = await step.run('materialize', () => materializeDeliveries(sentBy, docKey, version));
  if (!m.ok) return { skipped: m.reason };
  let sent = 0;
  let failed = 0;
  let remaining = m.recipientCount;
  const maxBatches = Math.ceil(m.recipientCount / LEGAL_NOTICE_BATCH_SIZE) + 2;
  for (let i = 0; i < maxBatches && remaining > 0; i++) {
    const r = await step.run(`batch-${i}`, () => sendNextBatch(sentBy, docKey, version));
    sent += r.sent;
    failed += r.failed;
    remaining = r.remaining;
  }
  if (remaining > 0) {
    await step.run('fail-leftover', () =>
      failQueuedDeliveries(sentBy, docKey, version, 'BATCH_CAP_REACHED')
    );
  }
  logger.info(
    { docKey, version, recipientCount: m.recipientCount, sent, failed },
    '[LEGAL-NOTICE] done'
  );
  return { recipientCount: m.recipientCount, sent, failed };
}

export const legalNoticeSend = inngest.createFunction(
  {
    id: 'legal-notice-send',
    name: 'Legal: email a material policy change to every store owner',
    concurrency: { limit: 1 },
    retries: 4,
    triggers: [{ event: 'legal/notice.send-requested' }],
    onFailure: async ({ event }) => {
      const d = (event?.data?.event?.data ?? {}) as SendData;
      if (!d.docKey || !d.version || !d.sentBy) return;
      const n = await failQueuedDeliveries(d.sentBy, d.docKey, d.version, 'SEND_JOB_FAILED');
      logger.error({ ...d, marked: n }, '[LEGAL-NOTICE] send job failed');
    },
  },
  async ({ event, step }) =>
    runLegalNoticeSend({ event: event as { data?: SendData }, step: step as unknown as StepLike })
);
```

(When the loop starts with `remaining = recipientCount = 0` no batch runs.)

`apps/api/src/lib/inngest/client.ts`, before `export type AppEvent`:

```ts
// Material legal-policy change (Ruling LEGAL-4): emitted ONLY by the super-admin
// POST /admin/legal-policies/:docKey/:version/send-notice; see functions/legal-notice-send.ts.
type LegalNoticeSendRequestedEvent = EventPayload & {
  name: 'legal/notice.send-requested';
  data: { docKey: string; version: string; sentBy: string };
};
```

and add `| LegalNoticeSendRequestedEvent` as the last member of `AppEvent`.

`apps/api/src/lib/inngest/functions/index.ts`: `import { legalNoticeSend } from './legal-notice-send';` and add to `allInngestFunctions` after `campaignSend`:

```ts
  // Material legal-policy change: one email per store owner (Ruling LEGAL-4).
  legalNoticeSend,
```

`tests/unit/no-rls-bypass-in-runtime.test.ts`, add to `ALLOWED_PLATFORM_OPERATOR`:

```ts
      'apps/api/src/services/legal-notice.service.ts':
        'legal-notice fan-out: every store owner, as the super admin who pressed Send notice',
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npx vitest run tests/unit/legal-notice-email.test.ts tests/unit/no-rls-bypass-in-runtime.test.ts tests/unit/inngest-step-serialization.test.ts
# the service now imports more of @ebda/database: the signup unit tests mock it partially, re-prove them
npx vitest run tests/unit/merchant-signup-legal.test.ts tests/unit/ebda-ads-signup-persist.test.ts
npx vitest run tests/integration/legal-notice-fanout.test.ts --retry=1
tsc --noEmit -p apps/api/tsconfig.json
```

Expected: all PASS; tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/email-templates/legal-notice.ts apps/api/src/services/platform-mailer.ts apps/api/src/services/legal-notice.service.ts apps/api/src/lib/inngest/functions/legal-notice-send.ts apps/api/src/lib/inngest/client.ts apps/api/src/lib/inngest/functions/index.ts tests/unit/no-rls-bypass-in-runtime.test.ts tests/unit/legal-notice-email.test.ts tests/integration/legal-notice-fanout.test.ts
git commit -m "feat(api): idempotent legal-notice email fan-out to store owners"
```

---

### Task 8: Super-admin "Policy updates" (API + page + nav)

**Files:**

- Modify: `apps/api/src/services/legal-notice.service.ts` (append `policyOverview`, `requestNoticeSend`)
- Modify: `apps/api/src/routes/legal-policy.routes.ts` (append `adminLegalPolicyRoutes`)
- Modify: `apps/api/src/routes/index.ts` (mount before `router.use('/admin', adminProviderActivationRoutes);`)
- Create: `apps/admin/src/app/policy-updates/page.tsx`, `apps/admin/src/app/policy-updates/page.test.tsx`
- Modify: `apps/admin/src/components/admin-layout/buildStoreAdminNav.ts` (`NavLabels.platformPolicyUpdates` + entry before Platform settings), `apps/admin/src/components/AdminLayout.tsx:120` (label)
- Modify: `apps/admin/src/i18n/messages/en.json`, `ar.json` (`policyUpdates`, `components.adminLayout.navPlatformPolicyUpdates`)
- Test: `tests/integration/legal-policy-admin.test.ts` (new)

**Interfaces:**

- Consumes: `currentLegalVersion`, `isLegalDocKey`, `LEGAL_DOC_KEYS`, `LEGAL_DOC_TITLE`, `type LegalVersion` (Task 1); `inngest` client; `isP2002` (`apps/api/src/lib/prisma-errors.ts`); `auditLog` (`apps/api/src/middleware/security.ts`); `requireMfaEnrolled` (`apps/api/src/middleware/require-mfa.ts`).
- Produces:
  - `interface LegalPolicyOverviewRow { docKey; title: {ar;en}; current: LegalVersion; send: { sentAt: string; sentBy: string; recipientCount: number | null } | null; deliveries: { queued; sending; sent; failed }; acceptedCount: number; canSend: boolean }`
  - `policyOverview(operatorId: string): Promise<LegalPolicyOverviewRow[]>`
  - `requestNoticeSend(operatorId: string, docKey: string, version: string): Promise<{ docKey: string; version: string; sentAt: string }>`
  - `GET /api/v1/admin/legal-policies` → `{ policies: LegalPolicyOverviewRow[] }`; `POST /api/v1/admin/legal-policies/:docKey/:version/send-notice` → 202 `{ send }` | 404 `NOT_FOUND` | 422 `NOT_CURRENT`/`NOT_MATERIAL` | 409 `ALREADY_SENT` | 502 `ENQUEUE_FAILED`.

- [ ] **Step 1: Write the failing tests**

`tests/integration/legal-policy-admin.test.ts`:

```ts
/**
 * Super-admin "Send notice" (Ruling LEGAL-4) over HTTP on the strict-RLS `ebda_app` login.
 * Review Focus 6: a second send is 409 with no second event; an enqueue failure leaves no row.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { createPrismaClient, runWithRequestDb, type AppPrismaClient } from '@ebda/database';
import { LEGAL_POLICIES, type LegalPolicies } from '@ebda/shared';
import { config } from '@api/config';
import { inngest } from '@api/lib/inngest/client';
import { adminLegalPolicyRoutes } from '@api/routes/legal-policy.routes';
import { errorHandler } from '@api/middleware/error-handler';
import { awaitDeferredWork } from '@api/lib/after-tenant-commit';
import { __setLegalPoliciesForTests } from '@api/services/legal-notice.service';

// The admin routes require MFA enrolment; the gate itself is covered elsewhere.
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_q: unknown, _s: unknown, next: () => void) => next(),
}));

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const APP_PASSWORD = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
const hasDb = !!OWNER_URL && !OWNER_URL.includes('localhost:5432/test_db');
const run = crypto.randomUUID().slice(0, 8);
const V = '99.0';
const FIXTURE: LegalPolicies = {
  ...LEGAL_POLICIES,
  terms: {
    history: [
      ...LEGAL_POLICIES.terms.history,
      {
        version: V,
        publishedAt: '2026-10-20',
        effectiveAt: '2026-11-20',
        material: true,
        feeChange: true,
        summary: { ar: 'تغيير تجريبي في الرسوم.', en: 'Test fee change.' },
      },
    ],
  },
};

function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = APP_PASSWORD;
  return u.toString();
}
const asApp = <T>(fn: () => Promise<T>) =>
  runWithRequestDb(() => createPrismaClient({ connectionString: appUrl(), max: 3 }), fn, {
    beforeDisconnect: () => awaitDeferredWork(5000),
  });
const token = (userId: string, role: 'store_admin' | 'super_admin') =>
  jwt.sign({ userId, email: `${userId}@example.test`, role, tv: 0 }, config.jwtSecret, {
    expiresIn: '30m',
    issuer: 'ebda-api',
    audience: 'ebda-app',
  });

describe.skipIf(!hasDb)('super-admin policy updates', () => {
  let owner: AppPrismaClient;
  let app: Express;
  let op = '';
  let merchant = '';
  let send = vi.spyOn(inngest, 'send');

  const mkUser = async (tag: string, role: 'store_admin' | 'super_admin') =>
    (
      await owner.user.create({
        data: {
          email: `lpa-${tag}-${run}-${crypto.randomUUID().slice(0, 6)}@test.local`,
          passwordHash: 'x',
          firstName: 'Lpa',
          lastName: tag,
          role,
          emailVerified: true,
        },
      })
    ).id;
  const call = (
    method: 'get' | 'post',
    userId: string,
    role: 'store_admin' | 'super_admin',
    url: string
  ) =>
    asApp(async () => {
      const r = request(app)
        [method](url)
        .set('Authorization', `Bearer ${token(userId, role)}`);
      return method === 'get' ? r : r.send({});
    });
  const sendUrl = (docKey: string, version: string) =>
    `/api/v1/admin/legal-policies/${docKey}/${version}/send-notice`;
  const wipe = () => owner.legalNoticeSend.deleteMany({ where: { docKey: 'terms', version: V } });

  beforeAll(async () => {
    owner = createPrismaClient({ connectionString: OWNER_URL, max: 2, role: 'owner' });
    __setLegalPoliciesForTests(FIXTURE);
    app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use('/api/v1/admin', adminLegalPolicyRoutes);
    app.use(errorHandler);
    op = await mkUser('op', 'super_admin');
    merchant = await mkUser('m', 'store_admin');
  });
  beforeEach(async () => {
    await wipe();
    send = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: ['evt'] } as never);
  });
  afterAll(async () => {
    await wipe();
    __setLegalPoliciesForTests(null);
    await owner.user.deleteMany({ where: { id: { in: [op, merchant] } } });
    await owner.$disconnect();
  });

  it('lists every document with its current version; only a super admin may read it', async () => {
    const res = await call('get', op, 'super_admin', '/api/v1/admin/legal-policies');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const rows = res.body.data.policies as Array<{
      docKey: string;
      current: { version: string };
      canSend: boolean;
      send: unknown;
    }>;
    expect(rows.map(r => r.docKey)).toEqual([
      'legal',
      'privacy',
      'terms',
      'acceptableUse',
      'merchant',
    ]);
    const terms = rows.find(r => r.docKey === 'terms')!;
    expect(terms).toMatchObject({ current: { version: V }, canSend: true, send: null });
    expect(rows.find(r => r.docKey === 'privacy')!.canSend).toBe(false);
    expect(
      (await call('get', merchant, 'store_admin', '/api/v1/admin/legal-policies')).status
    ).toBe(403);
  });

  it('refuses a non-material, a non-current and an unknown document', async () => {
    expect((await call('post', op, 'super_admin', sendUrl('privacy', '1.0'))).body.error.code).toBe(
      'NOT_MATERIAL'
    );
    expect((await call('post', op, 'super_admin', sendUrl('terms', '1.0'))).body.error.code).toBe(
      'NOT_CURRENT'
    );
    expect((await call('post', op, 'super_admin', sendUrl('cookies', '1.0'))).status).toBe(404);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends once; a second click is 409 with no second event', async () => {
    const first = await call('post', op, 'super_admin', sendUrl('terms', V));
    expect(first.status).toBe(202);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      name: 'legal/notice.send-requested',
      data: { docKey: 'terms', version: V, sentBy: op },
    });
    expect(
      await owner.legalNoticeSend.count({ where: { docKey: 'terms', version: V, sentBy: op } })
    ).toBe(1);
    const second = await call('post', op, 'super_admin', sendUrl('terms', V));
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('ALREADY_SENT');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('an enqueue failure answers 502 and leaves no send row (nothing half-announced)', async () => {
    send.mockRejectedValueOnce(new Error('inngest down'));
    const res = await call('post', op, 'super_admin', sendUrl('terms', V));
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('ENQUEUE_FAILED');
    expect(await owner.legalNoticeSend.count({ where: { docKey: 'terms', version: V } })).toBe(0);
  });

  it('a store_admin cannot send', async () => {
    expect((await call('post', merchant, 'store_admin', sendUrl('terms', V))).status).toBe(403);
  });
});
```

`apps/admin/src/app/policy-updates/page.test.tsx`:

```tsx
// @vitest-environment jsdom
/** Policy updates (Ruling LEGAL-4): in-page confirmation, one POST, 409 explained. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('../../lib/api', () => ({ apiGet, apiPost }));
vi.mock('next-intl', () => ({ useLocale: () => 'ar' }));
vi.mock('../../components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../components/RequireSuperAdmin', () => ({
  RequireSuperAdmin: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../i18n/useT', () => {
  const t = (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key;
  return { useT: () => t };
});
vi.mock('@ebda/ui', () => ({
  Button: (p: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...p} />,
}));

import PolicyUpdatesPage from './page';

const row = (docKey: string, material: boolean, send: unknown = null) => ({
  docKey,
  title: { ar: `عنوان ${docKey}`, en: docKey },
  current: {
    version: material ? '1.1' : '1.0',
    publishedAt: '2026-10-20',
    effectiveAt: '2026-11-20',
    material,
    feeChange: material,
    summary: { ar: 'ملخص', en: 'summary' },
  },
  send,
  deliveries: { queued: 0, sending: 0, sent: 0, failed: 0 },
  acceptedCount: 1234,
  canSend: material && !send,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('policy updates page', () => {
  it('asks for confirmation in the page before sending, then posts once', async () => {
    apiGet.mockResolvedValue({
      data: { policies: [row('terms', true), row('privacy', false)] },
      error: null,
    });
    apiPost.mockResolvedValue({ data: { send: {} }, error: null });
    const confirm = vi.spyOn(window, 'confirm');
    render(<PolicyUpdatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'sendNotice' }));
    expect(apiPost).not.toHaveBeenCalled();
    expect(screen.getByText('confirmBody')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'confirmSend' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith('/api/v1/admin/legal-policies/terms/1.1/send-notice', {});
    expect(await screen.findByText('sendStarted')).toBeTruthy();
    expect(confirm).not.toHaveBeenCalled();
    // only the material, unsent version offers the button
    expect(screen.queryAllByRole('button', { name: 'sendNotice' })).toHaveLength(1);
  });

  it('cancel closes the confirmation without posting', async () => {
    apiGet.mockResolvedValue({ data: { policies: [row('terms', true)] }, error: null });
    render(<PolicyUpdatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'sendNotice' }));
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(screen.queryByText('confirmBody')).toBeNull();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('explains a 409 and shows Latin-digit counts', async () => {
    apiGet.mockResolvedValue({ data: { policies: [row('terms', true)] }, error: null });
    apiPost.mockResolvedValue({
      data: null,
      error: { status: 409, code: 'ALREADY_SENT', message: 'x' },
    });
    render(<PolicyUpdatesPage />);
    expect((await screen.findByText(/accepted:/)).textContent).toContain('"n":"1234"');
    fireEvent.click(screen.getByRole('button', { name: 'sendNotice' }));
    fireEvent.click(screen.getByRole('button', { name: 'confirmSend' }));
    expect(await screen.findByText('alreadySent')).toBeTruthy();
  });

  it('a failed load says so instead of an empty table', async () => {
    apiGet.mockResolvedValue({ data: null, error: { status: 500, code: 'X', message: 'x' } });
    render(<PolicyUpdatesPage />);
    expect(await screen.findByText('loadFailed')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/admin/src/app/policy-updates/page.test.tsx` and (Test environment) `npx vitest run tests/integration/legal-policy-admin.test.ts --retry=1`
Expected: FAIL, `Failed to resolve import "./page"` / `adminLegalPolicyRoutes` is undefined.

- [ ] **Step 3: Write the implementation**

Append to `apps/api/src/services/legal-notice.service.ts` (merge imports):

```ts
import {
  LEGAL_DOC_KEYS,
  LEGAL_DOC_TITLE,
  currentLegalVersion,
  type LegalDocKey,
  type LegalVersion,
} from '@ebda/shared';
import { inngest } from '../lib/inngest/client';
import { isP2002 } from '../lib/prisma-errors';

export interface LegalPolicyOverviewRow {
  docKey: LegalDocKey;
  title: { ar: string; en: string };
  current: LegalVersion;
  send: { sentAt: string; sentBy: string; recipientCount: number | null } | null;
  deliveries: Record<DeliveryStatus, number>;
  acceptedCount: number;
  /** Material, current, and not yet announced. */
  canSend: boolean;
}

/** The super-admin page: each document's current version, its notice and delivery counts. */
export async function policyOverview(operatorId: string): Promise<LegalPolicyOverviewRow[]> {
  const sends = await prisma.legalNoticeSend.findMany({
    select: { docKey: true, version: true, sentAt: true, sentBy: true, recipientCount: true },
  });
  return asPlatformOperator(operatorId, async () => {
    const rows: LegalPolicyOverviewRow[] = [];
    for (const docKey of LEGAL_DOC_KEYS) {
      const current = currentLegalVersion(activePolicies, docKey);
      const send = sends.find(s => s.docKey === docKey && s.version === current.version) ?? null;
      const deliveries: Record<DeliveryStatus, number> = {
        queued: 0,
        sending: 0,
        sent: 0,
        failed: 0,
      };
      if (send) {
        for (const status of Object.keys(deliveries) as DeliveryStatus[]) {
          deliveries[status] = await prisma.legalNoticeDelivery.count({
            where: { docKey, version: current.version, status },
          });
        }
      }
      const acceptedCount = await prisma.legalAcceptance.count({
        where: { docKey, version: current.version },
      });
      rows.push({
        docKey,
        title: LEGAL_DOC_TITLE[docKey],
        current,
        send: send
          ? {
              sentAt: send.sentAt.toISOString(),
              sentBy: send.sentBy,
              recipientCount: send.recipientCount,
            }
          : null,
        deliveries,
        acceptedCount,
        canSend: current.material && !send,
      });
    }
    return rows;
  });
}

/**
 * Announce a material version: one `legal_notice_sends` row (UNIQUE per version -> a second
 * click is 409), then the Inngest event. Queue-then-send fails fast: if the enqueue throws,
 * the row is removed and the caller gets 502, so nothing is left half-announced (no banner
 * without an email run).
 */
export async function requestNoticeSend(
  operatorId: string,
  docKey: string,
  version: string
): Promise<{ docKey: string; version: string; sentAt: string }> {
  if (!isLegalDocKey(docKey)) throw new AppError(404, 'NOT_FOUND', 'Unknown legal document');
  const current = currentLegalVersion(activePolicies, docKey);
  if (current.version !== version) {
    throw new AppError(
      422,
      'NOT_CURRENT',
      'Only the current version of a document can be announced'
    );
  }
  if (!current.material) {
    throw new AppError(
      422,
      'NOT_MATERIAL',
      'This version is not marked material in LEGAL_POLICIES'
    );
  }
  let row: { id: string; sentAt: Date };
  try {
    row = await prisma.legalNoticeSend.create({
      data: { docKey, version, sentBy: operatorId },
      select: { id: true, sentAt: true },
    });
  } catch (err) {
    if (isP2002(err)) {
      throw new AppError(409, 'ALREADY_SENT', 'A notice for this version was already sent');
    }
    throw err;
  }
  try {
    await inngest.send({
      name: 'legal/notice.send-requested',
      data: { docKey, version, sentBy: operatorId },
    });
  } catch (err) {
    logger.error({ err, docKey, version }, '[LEGAL-NOTICE] enqueue failed, removing the send row');
    await prisma.legalNoticeSend
      .delete({ where: { id: row.id } })
      .catch(e => logger.error({ err: e, docKey, version }, '[LEGAL-NOTICE] compensation failed'));
    throw new AppError(
      502,
      'ENQUEUE_FAILED',
      'Could not start the email send; nothing was sent. Try again.'
    );
  }
  return { docKey, version, sentAt: row.sentAt.toISOString() };
}
```

Append to `apps/api/src/routes/legal-policy.routes.ts` (merge imports):

```ts
import { z } from 'zod';
import { requireMfaEnrolled } from '../middleware/require-mfa';
import { auditLog } from '../middleware/security';
import { policyOverview, requestNoticeSend } from '../services/legal-notice.service';

/**
 *  Super admin (mounted at /admin, BEFORE adminRoutes' catch-all MFA gate; carries its own chain):
 *    GET  /legal-policies                                   every document's current version + notice state
 *    POST /legal-policies/:docKey/:version/send-notice      announce a material version (202 | 409 | 422 | 502)
 */
export const adminLegalPolicyRoutes = Router();
const superAdmin = [authenticate, requireMfaEnrolled, authorize('super_admin')];
const sendParams = z.object({
  docKey: z.string().max(40),
  version: z
    .string()
    .regex(/^\d+(\.\d+)*$/)
    .max(20),
});

adminLegalPolicyRoutes.get(
  '/legal-policies',
  ...superAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const policies = await policyOverview(req.user!.userId);
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, data: { policies } });
    } catch (error) {
      next(error);
    }
  }
);

adminLegalPolicyRoutes.post(
  '/legal-policies/:docKey/:version/send-notice',
  ...superAdmin,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { docKey, version } = parseInput(sendParams, req.params);
      const send = await requestNoticeSend(req.user!.userId, docKey, version);
      await auditLog({
        action: 'legal.notice_sent',
        userId: req.user!.userId,
        resourceType: 'legal_policy',
        resourceId: `${docKey}@${version}`,
        details: { docKey, version },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.status(202).json({ success: true, data: { send } });
    } catch (error) {
      next(error);
    }
  }
);
```

`apps/api/src/routes/index.ts`: extend the import to `import { meLegalNoticeRoutes, adminLegalPolicyRoutes } from './legal-policy.routes';` and add, directly before `router.use('/admin', adminProviderActivationRoutes);`:

```ts
// Super-admin policy updates (Ruling LEGAL-4). BEFORE adminRoutes' catch-all MFA gate; it
// carries its own authenticate -> MFA -> super_admin chain.
router.use('/admin', adminLegalPolicyRoutes);
```

`apps/admin/src/app/policy-updates/page.tsx`:

```tsx
'use client';

/**
 * Super-admin Policy updates - /policy-updates (Ruling LEGAL-4).
 *
 * Each legal document's current version (from LEGAL_POLICIES via the API). A material version
 * with no notice yet gets "Send notice": an in-page confirmation (no window.confirm), then ONE
 * POST that emails every store owner and turns on the dashboard banner. Delivery and
 * acknowledgement counts show what happened.
 *
 * Route guard: super_admin only (RequireSuperAdmin + the API's MFA + super_admin chain).
 */
import { useCallback, useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { Button } from '@ebda/ui';
import { formatLegalDate, type LegalDocKey, type LegalVersion } from '@ebda/shared';
import { AdminLayout } from '../../components/AdminLayout';
import { RequireSuperAdmin } from '../../components/RequireSuperAdmin';
import { apiGet, apiPost } from '../../lib/api';
import { useT } from '../../i18n/useT';

interface PolicyRow {
  docKey: LegalDocKey;
  title: { ar: string; en: string };
  current: LegalVersion;
  send: { sentAt: string; sentBy: string; recipientCount: number | null } | null;
  deliveries: { queued: number; sending: number; sent: number; failed: number };
  acceptedCount: number;
  canSend: boolean;
}

function PolicyUpdatesInner() {
  const t = useT('policyUpdates');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const [rows, setRows] = useState<PolicyRow[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [confirming, setConfirming] = useState<LegalDocKey | null>(null);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await apiGet<{ policies: PolicyRow[] }>('/api/v1/admin/legal-policies');
    setLoadError(!!error);
    setRows(data?.policies ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const send = async (row: PolicyRow) => {
    setSending(true);
    setMessage(null);
    const { error } = await apiPost(
      `/api/v1/admin/legal-policies/${row.docKey}/${encodeURIComponent(row.current.version)}/send-notice`,
      {}
    );
    setSending(false);
    setConfirming(null);
    setMessage(
      error ? (error.status === 409 ? t('alreadySent') : t('sendFailed')) : t('sendStarted')
    );
    await load();
  };

  if (rows === null) return <p className="text-sm text-muted-foreground">{t('loading')}</p>;
  if (loadError) {
    return (
      <p role="alert" className="text-sm text-destructive-ink">
        {t('loadFailed')}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <ul className="space-y-3">
        {rows.map(row => (
          <li key={row.docKey} className="rounded-lg border border-border p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-medium">{row.title[locale]}</h2>
              <span className="text-xs text-muted-foreground">
                {t('version', { version: row.current.version })}
              </span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('published', { date: formatLegalDate(row.current.publishedAt, locale) })}{' '}
              {t('effective', { date: formatLegalDate(row.current.effectiveAt, locale) })}
            </p>
            <p className="mt-1 text-sm">{row.current.summary[locale]}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {row.current.material ? t('material') : t('notMaterial')}
              {row.current.feeChange ? ` ${t('feeChange')}` : ''}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('accepted', { n: String(row.acceptedCount) })}
            </p>
            {row.send && (
              <p className="mt-1 text-xs text-muted-foreground">
                {t('sentAt', { date: formatLegalDate(row.send.sentAt.slice(0, 10), locale) })}{' '}
                {t('deliveries', {
                  total: String(row.send.recipientCount ?? 0),
                  sent: String(row.deliveries.sent),
                  failed: String(row.deliveries.failed),
                  queued: String(row.deliveries.queued),
                  sending: String(row.deliveries.sending),
                })}
              </p>
            )}
            {row.canSend && confirming !== row.docKey && (
              <div className="mt-3">
                <Button onClick={() => setConfirming(row.docKey)}>{t('sendNotice')}</Button>
              </div>
            )}
            {confirming === row.docKey && (
              <div className="mt-3 space-y-2 rounded-md bg-muted p-3 text-sm">
                <p className="font-medium">{t('confirmTitle')}</p>
                <p>{t('confirmBody')}</p>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => send(row)} disabled={sending}>
                    {sending ? t('sending') : t('confirmSend')}
                  </Button>
                  <Button onClick={() => setConfirming(null)} disabled={sending}>
                    {t('cancel')}
                  </Button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function PolicyUpdatesPage() {
  const t = useT('policyUpdates');
  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')} mode="super_admin">
      <RequireSuperAdmin>
        <PolicyUpdatesInner />
      </RequireSuperAdmin>
    </AdminLayout>
  );
}
```

i18n `en.json` (top level):

```json
  "policyUpdates": {
    "title": "Policy updates",
    "subtitle": "Legal documents, their current versions, and the notices sent to merchants.",
    "loading": "Loading…",
    "loadFailed": "Could not load the policy list.",
    "version": "Version {version}",
    "published": "Published {date}.",
    "effective": "Takes effect {date}.",
    "material": "Material change.",
    "notMaterial": "Not material: no notice needed.",
    "feeChange": "Affects fees (30 days' notice).",
    "accepted": "Accepted by {n} accounts.",
    "sentAt": "Notice sent {date}.",
    "deliveries": "Emails: {sent} sent, {failed} failed, {queued} waiting, {sending} in progress, of {total}.",
    "sendNotice": "Send notice",
    "confirmTitle": "Send this notice to every merchant?",
    "confirmBody": "Every store owner gets an email, and a banner appears in their dashboard until they press Got it. This cannot be undone or sent twice.",
    "confirmSend": "Yes, send it",
    "cancel": "Cancel",
    "sending": "Sending…",
    "sendStarted": "Notice sent. Emails are going out now.",
    "alreadySent": "A notice for this version was already sent.",
    "sendFailed": "Could not start the send. Nothing was sent. Try again."
  },
```

`ar.json`:

```json
  "policyUpdates": {
    "title": "تحديثات السياسات",
    "subtitle": "الوثائق القانونية وإصداراتها الحالية والإشعارات اللي اتبعتت للتجار.",
    "loading": "جارٍ التحميل…",
    "loadFailed": "ماقدرناش نحمّل قائمة السياسات.",
    "version": "الإصدار {version}",
    "published": "اتنشر {date}.",
    "effective": "يسري من {date}.",
    "material": "تغيير جوهري.",
    "notMaterial": "مش جوهري: مش محتاج إشعار.",
    "feeChange": "بيأثر على الرسوم (إشعار 30 يوم).",
    "accepted": "وافق عليه {n} حساب.",
    "sentAt": "الإشعار اتبعت {date}.",
    "deliveries": "الرسائل: {sent} اتبعتت، {failed} فشلت، {queued} مستنية، {sending} جاري إرسالها، من {total}.",
    "sendNotice": "ابعت الإشعار",
    "confirmTitle": "تبعت الإشعار ده لكل التجار؟",
    "confirmBody": "كل صاحب متجر هيوصله إيميل، وهيظهر له شريط في لوحة التحكم لحد ما يدوس «تمام، فهمت». مينفعش يتلغي أو يتبعت مرتين.",
    "confirmSend": "أيوه، ابعته",
    "cancel": "إلغاء",
    "sending": "جارٍ الإرسال…",
    "sendStarted": "الإشعار اتبعت. الإيميلات بتطلع دلوقتي.",
    "alreadySent": "إشعار الإصدار ده اتبعت قبل كده.",
    "sendFailed": "ماقدرناش نبدأ الإرسال. ماتبعتش حاجة. جرّب تاني."
  },
```

and under `components.adminLayout`: en `"navPlatformPolicyUpdates": "Policy updates"`, ar `"navPlatformPolicyUpdates": "تحديثات السياسات"`.

`buildStoreAdminNav.ts`: in `NavLabels`, before `platformSettings`:

```ts
/** Legal documents + material-change notices (super_admin only, Ruling LEGAL-4) */
platformPolicyUpdates: string;
```

and in `buildSuperAdminNav`, before the Platform settings item:

```ts
    {
      // Document-check icon — legal policy versions and merchant notices.
      name: labels.platformPolicyUpdates,
      href: '/policy-updates',
      icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
    },
```

`AdminLayout.tsx`, in `navLabels` before `platformSettings`:

```ts
    platformPolicyUpdates: t('navPlatformPolicyUpdates'),
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npx vitest run apps/admin/src/app/policy-updates/page.test.tsx tests/unit/admin-i18n-key-parity.test.ts tests/unit/admin-i18n-keys-resolve.test.ts
npx vitest run tests/integration/legal-policy-admin.test.ts --retry=1
tsc --noEmit -p apps/api/tsconfig.json && tsc --noEmit -p apps/admin/tsconfig.json
```

Expected: all PASS; both tsc runs exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/legal-notice.service.ts apps/api/src/routes/legal-policy.routes.ts apps/api/src/routes/index.ts apps/admin/src/app/policy-updates/page.tsx apps/admin/src/app/policy-updates/page.test.tsx apps/admin/src/components/admin-layout/buildStoreAdminNav.ts apps/admin/src/components/AdminLayout.tsx apps/admin/src/i18n/messages/en.json apps/admin/src/i18n/messages/ar.json tests/integration/legal-policy-admin.test.ts
git commit -m "feat(admin): super-admin policy updates page with send notice"
```

---

### Task 9: Docs, rulings, runbook, blast-radius sweep, live verification

**Files:**

- Create: `docs/runbooks/legal-policy-change.md`
- Modify: `docs/RULINGS.md` (append after the last ruling)
- Modify: `docs/runbooks/SUPER-ADMIN-PLAYBOOK.md` (new section before `## Where the code lives`)
- Modify: `docs/merchant/faq.md` (new question at the end of `## General`)
- Modify: `docs/ENVIRONMENT.md:53` (`CAMPAIGN_PLATFORM_SEND_INTERVAL_MS` line)

- [ ] **Step 1: Write the runbook**

`docs/runbooks/legal-policy-change.md`:

```markdown
# How to publish a legal policy change

Ruling LEGAL-4. The policy TEXT lives in `apps/marketing/src/lib/legal-ar.ts` (primary) and
`legal-en.ts`; the VERSION of each document lives in `LEGAL_POLICIES`
(`packages/shared/src/legal/index.ts`). Both change in the same PR.

## 1. Edit and version (one PR)

1. Edit the text in `legal-ar.ts` and `legal-en.ts`.
2. Append one entry to that document's `history` in `LEGAL_POLICIES`:
   - `version`: next number (`1.0` -> `1.1`; `2.0` for a rewrite).
   - `publishedAt`: the merge/deploy date (YYYY-MM-DD). It becomes "Last updated" on the page.
   - `effectiveAt`: when it binds. For a **fee change** at least 30 days after `publishedAt`
     (the unit test refuses less).
   - `material`: `true` if a merchant would reasonably want to know (fees, liability,
     data use, termination, new obligations). Typos and formatting are `false`.
   - `feeChange`: `true` only if fees change (implies `material: true`).
   - `summary.ar` / `summary.en`: one or two plain sentences on WHAT changed.
3. If the change adds a sub-processor, update the Privacy Policy first (Ruling LEGAL-3).
4. `npx vitest run packages/shared/src/__tests__/legal-policies.test.ts tests/unit/marketing-site.test.tsx`.

## 2. Merge and deploy

Merge. `cf-marketing-deploy.yml` republishes ebda.app. The API must also run the new
registry: `gh workflow run cf-api-deploy.yml` (API deploys are manual). Then check:

    curl -s https://ebda.app/terms/ | grep -o '<time[^<]*</time>'
    curl -s https://ebda.app/en/terms/ | grep -o '<time[^<]*</time>'
    curl -s https://api.ebda.app/health   # commit == main tip

## 3. Announce (material versions only)

Super admin -> **Policy updates** (`store.ebda.app/policy-updates`) -> the document shows the
new version with **Send notice** -> confirm. This emails every store owner once (owners of
non-deleted, non-demo stores, role store_admin) and shows a banner in their dashboard until
they press "Got it". It cannot be sent twice (409).

## 4. Verify

- The page shows "Emails: N sent, 0 failed ... of N" once the run finishes (refresh).
- A test merchant account sees the banner on any store page; "Got it" removes it everywhere.
- Read-only SQL on production:
  `SELECT status, count(*) FROM legal_notice_deliveries WHERE doc_key='terms' AND version='1.1' GROUP BY 1;`
- `failed` rows: their banner still shows (the second channel). Read `error`; a re-send of
  failed rows is not automated (Ruling LEGAL-5): handle individually.
```

- [ ] **Step 2: Rulings, playbook, FAQ, ENVIRONMENT**

Append to `docs/RULINGS.md`:

```markdown
Ruling LEGAL-4 — "We may update this policy and will post the new version here with its date; we will notify merchants of material changes" is implemented, not just promised. (1) Versions live in code: `LEGAL_POLICIES` (`packages/shared/src/legal`) is the only source of each document's version, publish date, effective date and material/fee flags; the marketing pages render their date/version from it, and `packages/shared/src/__tests__/legal-policies.test.ts` refuses a missing document, a non-increasing version, and a fee change with under 30 days' notice. (2) Acceptance is recorded: signup requires `acceptedLegal: true` (server-side, 400 otherwise) and writes one `legal_acceptances` row per document at its current version (source `signup`, ip, user agent) in the same transaction as the new account's profile write; "Got it" writes `notice_ack`. `legal_acceptances` is append-only for `ebda_app`. (3) The notice is non-blocking: a dismissible banner on every store page, per user, shown while a SENT material current version is unacknowledged; it never gates the admin. (4) Email goes to every OWNER of a non-deleted, non-demo store whose account is a live `store_admin`, once per user per version (`legal_notice_deliveries` UNIQUE, claimed `queued -> sending` before the send), in the user's language (fallback Arabic), throttled by the platform send pacer. It is a transactional/legal service notice and carries NO unsubscribe link, by design. A second send for the same version is refused (409); an enqueue failure removes the send row (502). Evidence: Ahmad 2026-10-15; `tests/integration/legal-{signup-acceptance,notices,notice-fanout,policy-admin,tables-rls}.test.ts`. Cost if wrong: a merchant disputes a change they say they were never told about, and only the delivery ledger + acceptance rows (not a banner they never saw) answer it.

Ruling LEGAL-5 — accepted residuals of LEGAL-4. (a) A crash between a successful send and its `sent` mark leaves the row in `sending`; it is never re-sent (at-most-once), and the Policy updates page shows it as "in progress". (b) `failed` deliveries are not retried automatically; the banner remains the second channel and the runbook says to handle them individually. (c) The pre-existing accounts (signed up before 2026-10-15) have no `signup` acceptance rows; v1.0 is non-material, so no banner or email asks them for one. (d) A merchant whose stored `users.language` is the legacy default `en` gets the English email. (e) Signup acceptance is atomic with the profile write but not with the account INSERT, which runs earlier through the `ebda_admin_user_ensure` definer; a failure between the two leaves an account with no acceptance rows and the signup request errors. Cost if wrong: one merchant without a recorded acceptance or without an email for one version, visible in the delivery counts.
```

`docs/runbooks/SUPER-ADMIN-PLAYBOOK.md`, before `## Where the code lives`:

```markdown
## How to publish a legal policy change

Follow `docs/runbooks/legal-policy-change.md`: edit the text + bump `LEGAL_POLICIES` in one PR,
deploy marketing AND the API, then for a material version press **Send notice** on
**Policy updates** (`/policy-updates`). Ruling LEGAL-4.
```

`docs/merchant/faq.md`, at the end of `## General`:

```markdown
### How will I know if the terms or policies change? — هعرف إزاي لو الشروط أو السياسات اتغيرت؟

Every policy page on ebda.app shows its version and the date it was last updated. When we make a
material change (for example to fees), we email the store owner and show a notice in your
dashboard with a summary, the date it takes effect and a link; press "Got it" to dismiss it.
Fee changes always come with at least 30 days' notice.

كل صفحة سياسة على ebda.app بتوضح رقم الإصدار وتاريخ آخر تحديث. لما نعمل تغيير جوهري (زي الرسوم)
بنبعت إيميل لصاحب المتجر وبيظهر لك إشعار في لوحة التحكم فيه ملخص التغيير وتاريخ سريانه ورابط
للسياسة؛ دوس «تمام، فهمت» علشان يختفي. أي تغيير في الرسوم بيكون بإشعار 30 يوم على الأقل.
```

`docs/ENVIRONMENT.md` line 53: append to the end of the `CAMPAIGN_PLATFORM_SEND_INTERVAL_MS` bullet:

```markdown
The same pacer also spaces the legal-notice emails (`legal-notice-send`, Ruling LEGAL-4), so an announcement to every merchant shares the bound with running campaigns.
```

- [ ] **Step 3: Blast-radius sweep (state the result in the final report)**

Run each and confirm the expected result:

```bash
git grep -n "updated\.date\|updated\.version\|'Version 1.0'\|'الإصدار 1.0'\|7 October 2026\|7 أكتوبر 2026\|dateTime=\"2026-10-07\"" -- apps packages tests          # expect: no hits outside legal-policies.test.ts fixtures
git grep -n "merchant/signup[^-]" -- ':!*.md' | grep -v "signup-token\|merchant-signup.routes\|security.ts\|abuse-config\|merchant-signup-limits"   # every hit sends acceptedLegal (open each)
git grep -n "acceptedLegal" -- apps tests scripts                       # schema, page, page test, 6 integration callers, e2e script, 3 unit tests
git grep -n "LegalAcceptance\|legal_acceptances\|LegalNoticeDelivery\|legal_notice_deliveries\|LegalNoticeSend\|legal_notice_sends" -- apps packages tests docs   # schema, migration, guard, snapshot, service, rls tests, rulings, runbook
git grep -n "legal/notice.send-requested" -- apps tests docs            # client.ts, function, service, admin test
git grep -n "/me/legal-notices\|/admin/legal-policies\|policy-updates" -- apps tests docs
git grep -n "ALLOWED_PLATFORM_OPERATOR" -A20 tests/unit/no-rls-bypass-in-runtime.test.ts | grep legal-notice
npm run gen:tenant-guard-schema -w packages/database -- --check
psql "$DATABASE_URL" -c "SELECT tc.table_name, rc.delete_rule FROM information_schema.referential_constraints rc JOIN information_schema.table_constraints tc ON tc.constraint_name = rc.constraint_name WHERE tc.table_name LIKE 'legal_%'"   # CASCADE only
```

Also confirm: the privacy policy already discloses "IP address, device and browser details" (`legal-en.ts`, "Technical data"), so recording ip/ua on acceptance needs no policy change and no version bump.

- [ ] **Step 4: Full gates**

Run:

```bash
npm run typecheck
npm run lint
npx vitest run tests/unit packages/shared/src apps/admin/src
npx vitest run tests/integration/legal-tables-rls.test.ts tests/integration/rls-ebda-app.test.ts --retry=0
npx vitest run tests/integration/legal-signup-acceptance.test.ts tests/integration/legal-notices.test.ts tests/integration/legal-notice-fanout.test.ts tests/integration/legal-policy-admin.test.ts tests/integration/self-serve-onboarding.test.ts tests/integration/merchant-signup-abuse.test.ts tests/integration/store-creation-tenant-guard.test.ts tests/integration/merchant-password-reset.test.ts --retry=1
npm run build -w apps/marketing
graphify update .
```

Expected: every command exits 0. Capture each exit code on its own line (no pipes) as evidence.

- [ ] **Step 5: Commit**

```bash
git add docs/runbooks/legal-policy-change.md docs/RULINGS.md docs/runbooks/SUPER-ADMIN-PLAYBOOK.md docs/merchant/faq.md docs/ENVIRONMENT.md graphify-out
git commit -m "docs(legal): policy change runbook, rulings legal-4/5, merchant faq"
```

- [ ] **Step 6: After merge and deploy, verify against production (report both halves)**

```bash
gh workflow run cf-api-deploy.yml          # API deploys are manual; the migration runs here
curl -s https://api.ebda.app/health        # commit / deploymentId == main tip
curl -s https://ebda.app/terms/ | grep -o '<time[^<]*</time>'      # 7 أكتوبر 2026, from the registry
curl -s https://ebda.app/en/terms/ | grep -o '<time[^<]*</time>'   # 7 October 2026
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api.ebda.app/api/v1/auth/merchant/signup -H 'content-type: application/json' -d '{"email":"x@example.com"}'   # 400 (no account created)
# Read-only SQL (owner URL via neonctl): the tables exist, RLS forced, no rows yet.
psql "$PROD_DIRECT_URL" -c "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname LIKE 'legal_%' AND relkind='r'"
```

Report what could NOT be verified live and why. An email send to real merchants is NOT exercised: v1.0 is non-material, so there is nothing to send, and pressing Send notice would mail every merchant (ask Ahmad first). A real signup creates a real account, so ask before running one, or verify with the 400 probe above plus a read of the new account's `legal_acceptances` rows the next time a merchant signs up. The banner on production is proven only by tests until the first material version is sent.

```

```
