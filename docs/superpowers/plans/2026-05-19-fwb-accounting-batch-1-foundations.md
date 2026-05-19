# FWB Accounting Batch 1 — Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the accounting foundation — Chart of Accounts + double-entry Journal + sync posting on existing order/refund flows + read-only admin viewer + daily reconciliation jobs. After this batch a merchant placing a paid order or processing a refund sees a balanced journal entry post automatically.

**Architecture:** New Prisma models `Account` + `JournalEntry` + `JournalLine` with DB-level CHECK constraints + deferred DR=CR trigger. New `apps/api/src/services/accounting/` folder with `account.service.ts` (COA CRUD + seed) + `journal.service.ts` (idempotent post/reverse) + `posting/order-posting.ts` + `posting/refund-posting.ts`. Sync posting in the same Prisma `$transaction` as the operational write. New `apps/admin/src/app/stores/[id]/finance/{accounts,journal}` pages (read-only viewer + COA tree). Two new Inngest jobs (`accounting/daily-close` + `accounting/period-reconciliation`).

**Tech Stack:** Prisma + Postgres (Neon), Express + TypeScript, Next.js admin app, Inngest, Vitest, RLS via AsyncLocalStorage (existing `tenant-context.ts` pattern), per-store sequence via new `Sequence` table.

**Spec reference:** `docs/superpowers/specs/2026-05-19-fwb-accounting-stock-design.md` Parts 1.1/1.4, 2.1/2.2/2.4, 5, 6 (Finance group: `dashboard`/`journal`/`accounts` only — `expenses`/`reports`/`tax` ship in Batch 2/3), 8, 9 (Batch 1 scope).

**Out of scope for this batch:** PO/Supplier/StockAdjustment/Backorder/Expense (Batch 2), AI/smart layer (Batch 3), Insights (Batch 4), per-store dashboard with cashflow chart (Batch 2's Finance dashboard).

---

## File Structure

**Created:**

- `packages/database/prisma/migrations/<TS>_accounting_foundations/migration.sql` — schema + CHECK + deferred trigger + RLS + Sequence table
- `apps/api/src/services/accounting/account.service.ts` — COA CRUD
- `apps/api/src/services/accounting/coa-template.ts` — KW retail COA seed data (24 system accounts)
- `apps/api/src/services/accounting/journal.service.ts` — post/reverse with idempotency
- `apps/api/src/services/accounting/posting/order-posting.ts` — order-paid hook
- `apps/api/src/services/accounting/posting/refund-posting.ts` — refund-applied hook
- `apps/api/src/services/sequence.service.ts` — per-store entryNumber generator
- `apps/api/src/routes/finance.routes.ts` — GET accounts tree, GET journal list/detail, POST manual entry (super_admin only v1)
- `apps/api/src/lib/inngest/functions/accounting-daily-close.ts`
- `apps/api/src/lib/inngest/functions/accounting-period-reconciliation.ts`
- `apps/admin/src/app/stores/[id]/finance/accounts/page.tsx` — COA tree
- `apps/admin/src/app/stores/[id]/finance/journal/page.tsx` — entry list + drill-in
- `scripts/seed-coa-for-existing-stores.mjs` — one-off backfill
- `tests/integration/accounting-sale.test.ts`
- `tests/integration/accounting-refund.test.ts`
- `tests/integration/accounting-idempotency.test.ts`
- `tests/unit/accounting/journal-service.test.ts`
- `tests/unit/accounting/sequence-service.test.ts`

**Modified:**

- `packages/database/prisma/schema.prisma` — add 3 models, 3 enums, `Sequence` model, Store fields (`accountingEnabled`, `defaultTaxRateBps`, `fiscalYearStartMonth`)
- `packages/database/src/index.ts` — re-export new enums
- `apps/api/src/services/order.service.ts` — call `postOrderJournal` in `markPaid` transaction
- `apps/api/src/services/order.service.ts` (separate edit) — call `postRefundReversal` inside `applyRefundEffects`
- `apps/api/src/services/store.service.ts` — call `seedCoaForStore` in `createStore`
- `apps/api/src/routes/index.ts` — mount `/finance` router
- `apps/api/src/lib/inngest/index.ts` — register two new functions
- `apps/admin/src/components/Sidebar.tsx` (or equivalent) — add Finance group with Accounts + Journal links
- `apps/admin/messages/en.json` + `messages/ar.json` — strings for the two new admin pages

---

## Pre-flight (verify before Task 1)

- [ ] **P1:** Verify no other Claude session has touched the FWB Prisma schema today.

```bash
git log --since="6 hours ago" --name-only -- packages/database/prisma/schema.prisma
```

Expected: empty output, or only commits authored by Ahmad/Claude prior to this batch starting. If another session modified the schema, pause and rebase the spec against the latest schema before proceeding.

- [ ] **P2:** Confirm `git config user.email` is `ahmed0montaser@gmail.com` (Vercel Hobby author rule).

```bash
git config user.email
```

Expected: `ahmed0montaser@gmail.com`.

- [ ] **P3:** Snapshot prod DB before starting (rollback safety net).

```bash
bash scripts/backup-db.sh
```

Expected: file at `~/Desktop/projects/_backups/force-website-builder/<ts>-<sha>.sql.gz`.

---

## Task 1: Add Prisma schema models + enums + Store extensions

**Files:**

- Modify: `packages/database/prisma/schema.prisma`

- [ ] **Step 1: Add the three accounting enums + Sequence model + Store extensions.**

Append to `schema.prisma` (after `model NewsletterSubscriber` so it's in a logical "infrastructure" zone, or at the bottom):

```prisma
// ==========================================
// Accounting (Batch 1 — foundations)
// ==========================================

enum AccountType {
  asset
  liability
  equity
  revenue
  expense
}

enum JournalEntrySource {
  order
  refund
  purchase_order
  expense
  stock_adjustment
  manual
  period_close
  opening_balance
}

enum JournalEntryStatus {
  posted
  reversed
  draft
}

model Sequence {
  // Per-store, per-kind monotonically-increasing counter. Used for entryNumber,
  // poNumber, adjustmentNumber, expenseNumber. Atomic increment via FOR UPDATE.
  storeId String @map("store_id")
  kind    String // 'journal' | 'po' | 'adjustment' | 'expense'
  next    Int    @default(1)
  updatedAt DateTime @updatedAt @map("updated_at")

  @@id([storeId, kind])
  @@map("sequences")
}

model Account {
  id        String      @id @default(uuid())
  storeId   String      @map("store_id")
  code      String
  nameEn    String      @map("name_en")
  nameAr    String?     @map("name_ar")
  type      AccountType
  parentId  String?     @map("parent_id")
  isSystem  Boolean     @default(false) @map("is_system")
  isActive  Boolean     @default(true)  @map("is_active")
  createdAt DateTime    @default(now()) @map("created_at")
  updatedAt DateTime    @updatedAt      @map("updated_at")

  store    Store         @relation(fields: [storeId], references: [id], onDelete: Cascade)
  parent   Account?      @relation("AccountTree", fields: [parentId], references: [id])
  children Account[]     @relation("AccountTree")
  lines    JournalLine[]

  @@unique([storeId, code])
  @@index([storeId, type])
  @@map("accounts")
}

model JournalEntry {
  id           String             @id @default(uuid())
  storeId      String             @map("store_id")
  entryNumber  String             @map("entry_number")
  postedAt     DateTime           @map("posted_at")
  source       JournalEntrySource
  sourceId     String?            @map("source_id")
  reversedById String?            @unique @map("reversed_by_id")
  reversesId   String?            @unique @map("reverses_id")
  memo         String?
  memoAr       String?            @map("memo_ar")
  status       JournalEntryStatus @default(posted)
  postedBy     String?            @map("posted_by")
  createdAt    DateTime           @default(now()) @map("created_at")

  store      Store         @relation(fields: [storeId], references: [id], onDelete: Restrict)
  lines      JournalLine[]
  reversedBy JournalEntry? @relation("Reversal", fields: [reversedById], references: [id])
  reverses   JournalEntry? @relation("Reversal", fields: [reversesId], references: [id])

  @@unique([storeId, entryNumber])
  @@index([storeId, postedAt(sort: Desc)])
  @@index([source, sourceId])
  @@index([storeId, status])
  @@map("journal_entries")
}

model JournalLine {
  id         String   @id @default(uuid())
  entryId    String   @map("entry_id")
  accountId  String   @map("account_id")
  debit      Int      @default(0)
  credit     Int      @default(0)
  currency   String   @default("KWD")
  lineMemo   String?  @map("line_memo")
  lineMemoAr String?  @map("line_memo_ar")
  refTable   String?  @map("ref_table")
  refId      String?  @map("ref_id")
  createdAt  DateTime @default(now()) @map("created_at")

  entry   JournalEntry @relation(fields: [entryId], references: [id], onDelete: Cascade)
  account Account      @relation(fields: [accountId], references: [id], onDelete: Restrict)

  @@index([entryId])
  @@index([accountId])
  @@index([refTable, refId])
  @@map("journal_lines")
}
```

- [ ] **Step 2: Add `Store` extensions + reverse relations.** In the existing `model Store {…}` block:

Add scalar fields next to `currency`:

```prisma
  accountingEnabled    Boolean @default(true)  @map("accounting_enabled")
  defaultTaxRateBps    Int     @default(0)     @map("default_tax_rate_bps")
  fiscalYearStartMonth Int     @default(1)     @map("fiscal_year_start_month")
```

Add reverse relations at the bottom of the relations block (before `@@index`/`@@map`):

```prisma
  accounts       Account[]
  journalEntries JournalEntry[]
```

- [ ] **Step 3: Validate the schema.**

```bash
npm run db:generate -w packages/database
```

Expected: `✔ Generated Prisma Client` with no errors. If errors mention missing reverse relations, re-check Step 2.

- [ ] **Step 4: Commit schema only (migration follows in Task 2).**

```bash
git add packages/database/prisma/schema.prisma
git commit -m "feat(db): accounting schema — account, journal entry, journal line, sequence"
```

---

## Task 2: Hand-write the migration with CHECK + deferred DR=CR trigger + RLS

**Files:**

- Create: `packages/database/prisma/migrations/<TS>_accounting_foundations/migration.sql`

- [ ] **Step 1: Scaffold the migration via Prisma's diff-only mode (no apply yet).**

```bash
cd packages/database
npx prisma migrate dev --create-only --name accounting_foundations
```

Expected: new directory under `prisma/migrations/` with a `migration.sql` containing the `CREATE TABLE` statements for `accounts`, `journal_entries`, `journal_lines`, `sequences` and `ALTER TABLE stores` for the three new columns. Do NOT apply yet.

- [ ] **Step 2: Append the hand-written guards to the generated migration.sql.**

```sql
-- ============================================================================
-- Hand-written: CHECK constraints on journal_lines
-- ============================================================================

ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_debit_credit_nonneg"
  CHECK (debit >= 0 AND credit >= 0);

ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_debit_xor_credit"
  CHECK ((debit = 0 AND credit > 0) OR (debit > 0 AND credit = 0));

-- ============================================================================
-- Hand-written: deferred constraint trigger enforcing sum(DR)=sum(CR) per entry
-- ============================================================================

CREATE OR REPLACE FUNCTION journal_entry_dr_cr_balance_check() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  total_debit BIGINT;
  total_credit BIGINT;
BEGIN
  SELECT
    COALESCE(SUM(debit), 0),
    COALESCE(SUM(credit), 0)
  INTO total_debit, total_credit
  FROM journal_lines
  WHERE entry_id = NEW.id;

  IF total_debit <> total_credit THEN
    RAISE EXCEPTION 'Journal entry % is unbalanced: DR=% CR=%',
      NEW.id, total_debit, total_credit;
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER journal_entry_balanced
  AFTER INSERT OR UPDATE ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION journal_entry_dr_cr_balance_check();

-- ============================================================================
-- Hand-written: RLS policies on all 4 new tables (matches existing pattern
-- — runInTenantContext sets app.current_store_id GUC per request)
-- ============================================================================

ALTER TABLE "accounts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY accounts_tenant_isolation ON "accounts"
  USING (
    store_id::text = current_setting('app.current_store_id', true)
    OR current_setting('app.bypass_rls', true) = 'true'
  );

ALTER TABLE "journal_entries" ENABLE ROW LEVEL SECURITY;
CREATE POLICY journal_entries_tenant_isolation ON "journal_entries"
  USING (
    store_id::text = current_setting('app.current_store_id', true)
    OR current_setting('app.bypass_rls', true) = 'true'
  );

ALTER TABLE "journal_lines" ENABLE ROW LEVEL SECURITY;
CREATE POLICY journal_lines_tenant_isolation ON "journal_lines"
  USING (
    EXISTS (
      SELECT 1 FROM journal_entries e
      WHERE e.id = journal_lines.entry_id
        AND (
          e.store_id::text = current_setting('app.current_store_id', true)
          OR current_setting('app.bypass_rls', true) = 'true'
        )
    )
  );

ALTER TABLE "sequences" ENABLE ROW LEVEL SECURITY;
CREATE POLICY sequences_tenant_isolation ON "sequences"
  USING (
    store_id::text = current_setting('app.current_store_id', true)
    OR current_setting('app.bypass_rls', true) = 'true'
  );

-- ============================================================================
-- Hand-written: index on JournalLine.account for fast trial balance sums
-- (already declared in Prisma but indices on FK columns are repeated here
-- for safety in case schema drifts)
-- ============================================================================

CREATE INDEX IF NOT EXISTS journal_lines_account_id_idx
  ON journal_lines(account_id);
```

- [ ] **Step 3: Apply the migration locally + regenerate client.**

```bash
cd packages/database
npx prisma migrate dev
npm run build
```

Expected: migration applies cleanly; Prisma Client regenerates; `npm run build` exits 0.

- [ ] **Step 4: Smoke-test the DR=CR trigger via psql.**

```bash
psql "$DATABASE_URL" <<'EOF'
BEGIN;
INSERT INTO accounts (id, store_id, code, name_en, type, is_system, created_at, updated_at)
  VALUES ('00000000-0000-0000-0000-000000000001', '<pick any real storeId>', 'TEST', 'Test', 'asset', false, now(), now());
INSERT INTO journal_entries (id, store_id, entry_number, posted_at, source, status, created_at)
  VALUES ('00000000-0000-0000-0000-000000000002', '<same storeId>', 'TEST-1', now(), 'manual', 'posted', now());
INSERT INTO journal_lines (id, entry_id, account_id, debit, credit, created_at)
  VALUES ('00000000-0000-0000-0000-000000000003',
          '00000000-0000-0000-0000-000000000002',
          '00000000-0000-0000-0000-000000000001', 100, 0, now());
COMMIT;
EOF
```

Expected: ERROR `Journal entry … is unbalanced: DR=100 CR=0` at COMMIT. Trigger fires. Rollback.

- [ ] **Step 5: Commit migration.**

```bash
git add packages/database/prisma/migrations/
git commit -m "feat(db): migrate accounting foundations + dr=cr trigger + rls"
```

---

## Task 3: Re-export the new enums + types from `@force/database`

**Files:**

- Modify: `packages/database/src/index.ts`

- [ ] **Step 1: Write a unit test asserting the exports exist.**

`tests/unit/database-exports.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import * as db from '@force/database';

describe('@force/database exports', () => {
  it('exports the accounting enums', () => {
    expect(db.AccountType).toBeDefined();
    expect(db.JournalEntrySource).toBeDefined();
    expect(db.JournalEntryStatus).toBeDefined();
    expect(db.AccountType.asset).toBe('asset');
    expect(db.JournalEntrySource.order).toBe('order');
  });
});
```

- [ ] **Step 2: Run the test — it should fail (enums not yet re-exported).**

```bash
npm run test:unit -- tests/unit/database-exports.test.ts
```

Expected: FAIL — `AccountType is undefined` or similar.

- [ ] **Step 3: Add re-exports.** In `packages/database/src/index.ts`, alongside existing enum re-exports:

```ts
export { AccountType, JournalEntrySource, JournalEntryStatus } from '@prisma/client';
```

Plus `npm run db:generate -w packages/database` to make sure the client is fresh.

- [ ] **Step 4: Re-run the test — should pass.**

```bash
npm run test:unit -- tests/unit/database-exports.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add packages/database/src/index.ts tests/unit/database-exports.test.ts
git commit -m "feat(database): re-export accounting enums"
```

---

## Task 4: Build `sequence.service.ts` (per-store atomic counter)

**Files:**

- Create: `apps/api/src/services/sequence.service.ts`
- Test: `tests/unit/accounting/sequence-service.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@force/database';
import { nextSequence } from '../../../apps/api/src/services/sequence.service';

const STORE = '00000000-0000-0000-0000-0000000000aa';

describe('sequence.service', () => {
  beforeEach(async () => {
    await prisma.sequence.deleteMany({ where: { storeId: STORE } });
  });

  it('returns 1 on first call per (store, kind) and increments atomically', async () => {
    const first = await nextSequence(STORE, 'journal');
    const second = await nextSequence(STORE, 'journal');
    expect(first).toBe('JE-2026-000001');
    expect(second).toBe('JE-2026-000002');
  });

  it('isolates counters by kind', async () => {
    await nextSequence(STORE, 'journal');
    const po = await nextSequence(STORE, 'po');
    expect(po).toBe('PO-2026-000001');
  });

  it('survives concurrent calls without dupes', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => nextSequence(STORE, 'journal'))
    );
    expect(new Set(results).size).toBe(20);
  });
});
```

- [ ] **Step 2: Run test — should fail (module not found).**

```bash
npm run test:unit -- tests/unit/accounting/sequence-service.test.ts
```

Expected: FAIL `Cannot find module …/sequence.service`.

- [ ] **Step 3: Implement.**

`apps/api/src/services/sequence.service.ts`:

```ts
import { prisma } from '@force/database';

const PREFIX: Record<string, string> = {
  journal: 'JE',
  po: 'PO',
  adjustment: 'ADJ',
  expense: 'EXP',
};

/**
 * Atomically returns the next formatted identifier for a (storeId, kind) pair.
 * Uses INSERT … ON CONFLICT DO UPDATE … RETURNING to claim the next value in
 * a single statement (Postgres row lock is acquired by the upsert, so two
 * concurrent calls cannot return the same number).
 */
export async function nextSequence(storeId: string, kind: keyof typeof PREFIX): Promise<string> {
  const year = new Date().getUTCFullYear();
  const prefix = PREFIX[kind];
  if (!prefix) throw new Error(`Unknown sequence kind: ${kind}`);

  const row = await prisma.$queryRaw<{ next: number }[]>`
    INSERT INTO sequences (store_id, kind, next, updated_at)
    VALUES (${storeId}::uuid, ${kind}, 2, now())
    ON CONFLICT (store_id, kind)
    DO UPDATE SET next = sequences.next + 1, updated_at = now()
    RETURNING next - 1 AS next
  `;
  const n = row[0].next;
  return `${prefix}-${year}-${String(n).padStart(6, '0')}`;
}
```

- [ ] **Step 4: Run test — should pass.**

```bash
npm run test:unit -- tests/unit/accounting/sequence-service.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/services/sequence.service.ts tests/unit/accounting/sequence-service.test.ts
git commit -m "feat(api): per-store atomic sequence service"
```

---

## Task 5: Build `coa-template.ts` (KW retail COA seed data)

**Files:**

- Create: `apps/api/src/services/accounting/coa-template.ts`

- [ ] **Step 1: Define the seed data.**

`apps/api/src/services/accounting/coa-template.ts`:

```ts
import type { AccountType } from '@force/database';

export interface CoaTemplateRow {
  code: string;
  nameEn: string;
  nameAr: string;
  type: AccountType;
  parentCode?: string;
}

/**
 * Kuwait small-retail Chart of Accounts. All system accounts are locked
 * (isSystem=true). Merchants may add custom children freely.
 *
 * Code convention: 1000s=asset, 2000s=liability, 3000s=equity,
 * 4000s=revenue, 5000s=expense.
 */
export const COA_TEMPLATE: CoaTemplateRow[] = [
  { code: '1000', nameEn: 'Cash KNET', nameAr: 'كاش كي نت', type: 'asset' },
  { code: '1010', nameEn: 'Cash Card', nameAr: 'كاش بطاقات', type: 'asset' },
  { code: '1020', nameEn: 'Cash COD', nameAr: 'كاش الدفع عند الاستلام', type: 'asset' },
  { code: '1030', nameEn: 'Bank Main', nameAr: 'بنك رئيسي', type: 'asset' },
  { code: '1100', nameEn: 'Accounts Receivable', nameAr: 'الذمم المدينة', type: 'asset' },
  { code: '1200', nameEn: 'Inventory', nameAr: 'المخزون', type: 'asset' },
  { code: '2000', nameEn: 'Accounts Payable', nameAr: 'الذمم الدائنة', type: 'liability' },
  { code: '2100', nameEn: 'Tax Payable', nameAr: 'الضريبة المستحقة', type: 'liability' },
  { code: '3000', nameEn: "Owner's Equity", nameAr: 'حقوق الملكية', type: 'equity' },
  { code: '3100', nameEn: "Owner's Draws", nameAr: 'سحوبات المالك', type: 'equity' },
  { code: '4000', nameEn: 'Sales Revenue', nameAr: 'إيرادات المبيعات', type: 'revenue' },
  { code: '4010', nameEn: 'Shipping Income', nameAr: 'إيرادات الشحن', type: 'revenue' },
  { code: '4090', nameEn: 'Sales Returns', nameAr: 'مرتجعات المبيعات', type: 'revenue' },
  { code: '5000', nameEn: 'Cost of Goods Sold', nameAr: 'تكلفة البضاعة المباعة', type: 'expense' },
  { code: '5010', nameEn: 'COGS Variance', nameAr: 'فرق تكلفة البضاعة', type: 'expense' },
  { code: '5100', nameEn: 'Packaging', nameAr: 'التغليف', type: 'expense' },
  { code: '5200', nameEn: 'Marketing', nameAr: 'تسويق', type: 'expense' },
  { code: '5300', nameEn: 'Salaries', nameAr: 'رواتب', type: 'expense' },
  { code: '5400', nameEn: 'Rent', nameAr: 'إيجار', type: 'expense' },
  { code: '5500', nameEn: 'Utilities', nameAr: 'كهرباء وماء واتصالات', type: 'expense' },
  { code: '5600', nameEn: 'Software', nameAr: 'اشتراكات برمجية', type: 'expense' },
  { code: '5700', nameEn: 'Courier', nameAr: 'شحن وتوصيل', type: 'expense' },
  { code: '5800', nameEn: 'Bank Fees', nameAr: 'رسوم بنكية', type: 'expense' },
  { code: '5900', nameEn: 'Damage / Loss', nameAr: 'تلف وفقد', type: 'expense' },
  { code: '5910', nameEn: 'Theft', nameAr: 'سرقة', type: 'expense' },
  { code: '5920', nameEn: 'Write-off', nameAr: 'شطب', type: 'expense' },
  { code: '5990', nameEn: 'Other', nameAr: 'متفرقات', type: 'expense' },
];
```

- [ ] **Step 2: Commit.**

```bash
git add apps/api/src/services/accounting/coa-template.ts
git commit -m "feat(accounting): kw retail coa template (27 system accounts)"
```

---

## Task 6: Build `account.service.ts` (COA seed + CRUD)

**Files:**

- Create: `apps/api/src/services/accounting/account.service.ts`
- Test: `tests/integration/accounting-coa-seed.test.ts`

- [ ] **Step 1: Write failing integration test.**

```ts
import { describe, it, expect } from 'vitest';
import { prisma } from '@force/database';
import {
  seedCoaForStore,
  listAccountsTree,
} from '../../apps/api/src/services/accounting/account.service';

describe('account.service', () => {
  it('seeds 27 system accounts on a fresh store and is idempotent', async () => {
    const store = await prisma.store.create({
      data: {
        name: `coa-test-${Date.now()}`,
        slug: `coa-test-${Date.now()}`,
        ownerId: '00000000-0000-0000-0000-0000000000aa',
      },
    });

    await seedCoaForStore(store.id);
    const first = await prisma.account.count({ where: { storeId: store.id } });
    expect(first).toBe(27);

    // Re-running must not duplicate
    await seedCoaForStore(store.id);
    const second = await prisma.account.count({ where: { storeId: store.id } });
    expect(second).toBe(27);

    const tree = await listAccountsTree(store.id);
    expect(tree.assets.find(a => a.code === '1000')?.nameEn).toBe('Cash KNET');
    expect(tree.expenses.length).toBeGreaterThan(10);

    await prisma.account.deleteMany({ where: { storeId: store.id } });
    await prisma.store.delete({ where: { id: store.id } });
  });
});
```

- [ ] **Step 2: Run test — should fail.**

```bash
npm run test:integration -- tests/integration/accounting-coa-seed.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement.**

`apps/api/src/services/accounting/account.service.ts`:

```ts
import { prisma, AccountType } from '@force/database';
import { COA_TEMPLATE } from './coa-template';

/**
 * Seed the Kuwait-retail Chart of Accounts for a store. Idempotent —
 * existing system accounts are left as-is. Safe to re-run.
 */
export async function seedCoaForStore(storeId: string): Promise<void> {
  await prisma.$transaction(async tx => {
    const existing = await tx.account.findMany({
      where: { storeId, isSystem: true },
      select: { code: true },
    });
    const have = new Set(existing.map(a => a.code));

    const toCreate = COA_TEMPLATE.filter(row => !have.has(row.code));
    if (toCreate.length === 0) return;

    await tx.account.createMany({
      data: toCreate.map(row => ({
        storeId,
        code: row.code,
        nameEn: row.nameEn,
        nameAr: row.nameAr,
        type: row.type as AccountType,
        isSystem: true,
        isActive: true,
      })),
    });
  });
}

/**
 * Lookup helper used by posting services: get an account's id by code.
 * Throws if missing — callers should never reference a non-seeded code.
 */
export async function getSystemAccountIdByCode(
  storeId: string,
  code: string,
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0] = prisma
): Promise<string> {
  const acct = await tx.account.findUnique({
    where: { storeId_code: { storeId, code } },
    select: { id: true },
  });
  if (!acct) {
    throw new Error(`System account ${code} not found for store ${storeId} — seed COA first`);
  }
  return acct.id;
}

export interface AccountsTreeNode {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string | null;
  type: AccountType;
  isSystem: boolean;
  isActive: boolean;
  children: AccountsTreeNode[];
}

export async function listAccountsTree(storeId: string) {
  const all = await prisma.account.findMany({
    where: { storeId },
    orderBy: { code: 'asc' },
  });
  const byParent = new Map<string | null, AccountsTreeNode[]>();
  for (const a of all) {
    const node: AccountsTreeNode = {
      id: a.id,
      code: a.code,
      nameEn: a.nameEn,
      nameAr: a.nameAr,
      type: a.type,
      isSystem: a.isSystem,
      isActive: a.isActive,
      children: [],
    };
    const k = a.parentId;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k)!.push(node);
  }
  function attach(node: AccountsTreeNode) {
    node.children = byParent.get(node.id) ?? [];
    node.children.forEach(attach);
  }
  const roots = byParent.get(null) ?? [];
  roots.forEach(attach);
  return {
    assets: roots.filter(n => n.type === 'asset'),
    liabilities: roots.filter(n => n.type === 'liability'),
    equity: roots.filter(n => n.type === 'equity'),
    revenue: roots.filter(n => n.type === 'revenue'),
    expenses: roots.filter(n => n.type === 'expense'),
  };
}
```

- [ ] **Step 4: Run test — should pass.**

```bash
npm run test:integration -- tests/integration/accounting-coa-seed.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/services/accounting/account.service.ts tests/integration/accounting-coa-seed.test.ts
git commit -m "feat(accounting): coa seed (idempotent) + accounts tree query"
```

---

## Task 7: Build `journal.service.ts` (post + reverse with idempotency)

**Files:**

- Create: `apps/api/src/services/accounting/journal.service.ts`
- Test: `tests/unit/accounting/journal-service.test.ts`

- [ ] **Step 1: Write failing test.**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@force/database';
import { postEntry, reverseEntry } from '../../../apps/api/src/services/accounting/journal.service';
import {
  seedCoaForStore,
  getSystemAccountIdByCode,
} from '../../../apps/api/src/services/accounting/account.service';

let storeId: string;
let cashId: string;
let revId: string;

beforeAll(async () => {
  const s = await prisma.store.create({
    data: {
      name: `je-test-${Date.now()}`,
      slug: `je-test-${Date.now()}`,
      ownerId: '00000000-0000-0000-0000-0000000000aa',
    },
  });
  storeId = s.id;
  await seedCoaForStore(storeId);
  cashId = await getSystemAccountIdByCode(storeId, '1000');
  revId = await getSystemAccountIdByCode(storeId, '4000');
});

afterAll(async () => {
  await prisma.journalLine.deleteMany({ where: { entry: { storeId } } });
  await prisma.journalEntry.deleteMany({ where: { storeId } });
  await prisma.account.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
});

describe('journal.service', () => {
  it('posts a balanced entry', async () => {
    const entry = await postEntry({
      storeId,
      source: 'manual',
      sourceId: 'unit-test-1',
      memo: 'cash sale 1 KWD',
      lines: [
        { accountId: cashId, debit: 1000, credit: 0 },
        { accountId: revId, debit: 0, credit: 1000 },
      ],
    });
    expect(entry.status).toBe('posted');
    expect(entry.entryNumber).toMatch(/^JE-\d{4}-\d{6}$/);
  });

  it('refuses to post an unbalanced entry', async () => {
    await expect(
      postEntry({
        storeId,
        source: 'manual',
        sourceId: 'unit-test-bad',
        lines: [{ accountId: cashId, debit: 500, credit: 0 }],
      })
    ).rejects.toThrow(/unbalanced/i);
  });

  it('is idempotent on duplicate (source, sourceId)', async () => {
    const a = await postEntry({
      storeId,
      source: 'order',
      sourceId: 'order-99',
      lines: [
        { accountId: cashId, debit: 2000, credit: 0 },
        { accountId: revId, debit: 0, credit: 2000 },
      ],
    });
    const b = await postEntry({
      storeId,
      source: 'order',
      sourceId: 'order-99',
      lines: [
        { accountId: cashId, debit: 9999, credit: 0 },
        { accountId: revId, debit: 0, credit: 9999 },
      ],
    });
    expect(b.id).toBe(a.id);
    const lines = await prisma.journalLine.findMany({ where: { entryId: a.id } });
    expect(lines.find(l => l.debit === 2000)).toBeDefined();
    expect(lines.find(l => l.debit === 9999)).toBeUndefined();
  });

  it('reverses an entry by creating a mirror entry', async () => {
    const a = await postEntry({
      storeId,
      source: 'manual',
      sourceId: 'rev-1',
      lines: [
        { accountId: cashId, debit: 3000, credit: 0 },
        { accountId: revId, debit: 0, credit: 3000 },
      ],
    });
    const r = await reverseEntry(a.id, 'test reversal');
    expect(r.reversesId).toBe(a.id);
    const updated = await prisma.journalEntry.findUnique({ where: { id: a.id } });
    expect(updated?.status).toBe('reversed');
    const revLines = await prisma.journalLine.findMany({ where: { entryId: r.id } });
    expect(revLines.find(l => l.credit === 3000 && l.accountId === cashId)).toBeDefined();
    expect(revLines.find(l => l.debit === 3000 && l.accountId === revId)).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test — should fail.**

```bash
npm run test:integration -- tests/unit/accounting/journal-service.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement.**

`apps/api/src/services/accounting/journal.service.ts`:

```ts
import { prisma, JournalEntry, JournalEntrySource } from '@force/database';
import type { Prisma } from '@prisma/client';
import { nextSequence } from '../sequence.service';

export interface JournalLineInput {
  accountId: string;
  debit: number;
  credit: number;
  lineMemo?: string;
  lineMemoAr?: string;
  refTable?: string;
  refId?: string;
}

export interface PostEntryInput {
  storeId: string;
  source: JournalEntrySource;
  sourceId?: string;
  memo?: string;
  memoAr?: string;
  postedAt?: Date;
  postedBy?: string;
  lines: JournalLineInput[];
  /**
   * Optional Prisma transaction client — when provided, post happens inside
   * the caller's transaction (used by order-posting / refund-posting so the
   * journal and the operational write commit atomically).
   */
  tx?: Prisma.TransactionClient;
}

/**
 * Idempotent journal-entry post. Returns the existing entry if (source, sourceId)
 * already exists for this store. Validates DR=CR client-side; the DB-level
 * deferred trigger is the final guard.
 */
export async function postEntry(input: PostEntryInput): Promise<JournalEntry> {
  const totalDebit = input.lines.reduce((s, l) => s + l.debit, 0);
  const totalCredit = input.lines.reduce((s, l) => s + l.credit, 0);
  if (totalDebit !== totalCredit) {
    throw new Error(`Journal lines unbalanced: DR=${totalDebit} CR=${totalCredit}`);
  }
  if (input.lines.length === 0) {
    throw new Error('Journal entry requires at least one line');
  }

  const run = async (tx: Prisma.TransactionClient) => {
    if (input.sourceId) {
      const existing = await tx.journalEntry.findFirst({
        where: { storeId: input.storeId, source: input.source, sourceId: input.sourceId },
      });
      if (existing) return existing;
    }

    const entryNumber = await nextSequence(input.storeId, 'journal');
    const entry = await tx.journalEntry.create({
      data: {
        storeId: input.storeId,
        entryNumber,
        postedAt: input.postedAt ?? new Date(),
        source: input.source,
        sourceId: input.sourceId,
        memo: input.memo,
        memoAr: input.memoAr,
        status: 'posted',
        postedBy: input.postedBy,
        lines: {
          create: input.lines.map(l => ({
            accountId: l.accountId,
            debit: l.debit,
            credit: l.credit,
            lineMemo: l.lineMemo,
            lineMemoAr: l.lineMemoAr,
            refTable: l.refTable,
            refId: l.refId,
          })),
        },
      },
    });
    return entry;
  };

  return input.tx ? run(input.tx) : prisma.$transaction(run);
}

/**
 * Post the mirror of an existing entry (debits become credits and vice versa).
 * Marks the original status='reversed' and links both via reversedById/reversesId.
 */
export async function reverseEntry(
  originalId: string,
  reason?: string,
  tx?: Prisma.TransactionClient
): Promise<JournalEntry> {
  const run = async (t: Prisma.TransactionClient) => {
    const original = await t.journalEntry.findUnique({
      where: { id: originalId },
      include: { lines: true },
    });
    if (!original) throw new Error(`JournalEntry ${originalId} not found`);
    if (original.status === 'reversed') {
      throw new Error(`JournalEntry ${originalId} is already reversed`);
    }

    const entryNumber = await nextSequence(original.storeId, 'journal');
    const reversal = await t.journalEntry.create({
      data: {
        storeId: original.storeId,
        entryNumber,
        postedAt: new Date(),
        source: original.source,
        sourceId: original.sourceId ? `${original.sourceId}:reversal` : undefined,
        memo: reason ?? `Reversal of ${original.entryNumber}`,
        memoAr: reason ?? `إلغاء قيد ${original.entryNumber}`,
        status: 'posted',
        reversesId: original.id,
        lines: {
          create: original.lines.map(l => ({
            accountId: l.accountId,
            debit: l.credit,
            credit: l.debit,
            lineMemo: l.lineMemo,
            lineMemoAr: l.lineMemoAr,
            refTable: l.refTable,
            refId: l.refId,
          })),
        },
      },
    });
    await t.journalEntry.update({
      where: { id: original.id },
      data: { status: 'reversed', reversedById: reversal.id },
    });
    return reversal;
  };
  return tx ? run(tx) : prisma.$transaction(run);
}
```

- [ ] **Step 4: Run test — should pass.**

```bash
npm run test:integration -- tests/unit/accounting/journal-service.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/services/accounting/journal.service.ts tests/unit/accounting/journal-service.test.ts
git commit -m "feat(accounting): journal post + reverse with idempotency"
```

---

## Task 8: Build `posting/order-posting.ts` (hook into OrderService)

**Files:**

- Create: `apps/api/src/services/accounting/posting/order-posting.ts`
- Modify: `apps/api/src/services/order.service.ts` — call `postOrderPaymentJournal` inside `markPaid`'s transaction

- [ ] **Step 1: Implement the posting helper first (no test — covered by Task 11's integration test).**

`apps/api/src/services/accounting/posting/order-posting.ts`:

```ts
import type { Prisma } from '@prisma/client';
import { getSystemAccountIdByCode } from '../account.service';
import { postEntry } from '../journal.service';

const PROVIDER_TO_CASH_CODE: Record<string, string> = {
  myfatoorah: '1000', // Cash KNET
  tap: '1010', // Cash Card (Tap card transactions)
  hesabe: '1010',
  upayments: '1010',
  cod: '1020', // Cash COD
};

/**
 * Post the GL journal for an Order that just transitioned to paymentStatus=paid.
 * Called inside the same Prisma $transaction as the Order/Payment update so
 * the sale and the journal commit atomically. Idempotent via (source='order', sourceId=orderId).
 *
 * Schema posted:
 *   DR Cash[provider]           total + tax + shipping - discount
 *   CR Sales Revenue (net)      subtotal - discount
 *   CR Tax Payable              tax (only when tax > 0)
 *   CR Shipping Income          shipping (only when shipping > 0)
 *
 *   DR COGS                     sum(orderItem.qty * orderItem.costPrice)  — skipped per-line if costPriceDeferred=true
 *   CR Inventory                same amount
 */
export async function postOrderPaymentJournal(args: {
  tx: Prisma.TransactionClient;
  orderId: string;
}): Promise<void> {
  const { tx, orderId } = args;
  const order = await tx.order.findUnique({
    where: { id: orderId },
    include: { items: true, payments: { where: { status: 'completed' } }, store: true },
  });
  if (!order) throw new Error(`Order ${orderId} not found`);
  if (order.paymentStatus !== 'paid') return; // only post on paid
  if (!order.store?.accountingEnabled) return;

  const completedPayment = order.payments[0];
  const provider = completedPayment?.provider ?? 'cod';
  const cashCode = PROVIDER_TO_CASH_CODE[provider] ?? '1000';

  const cashAccountId = await getSystemAccountIdByCode(order.storeId, cashCode, tx);
  const revenueAccountId = await getSystemAccountIdByCode(order.storeId, '4000', tx);
  const taxPayableAccountId = await getSystemAccountIdByCode(order.storeId, '2100', tx);
  const shippingIncomeId = await getSystemAccountIdByCode(order.storeId, '4010', tx);
  const cogsAccountId = await getSystemAccountIdByCode(order.storeId, '5000', tx);
  const inventoryAccountId = await getSystemAccountIdByCode(order.storeId, '1200', tx);

  // --- Cash / revenue side ---
  const netRevenue = order.subtotal - order.discount; // net-of-discount model
  const lines: Array<{ accountId: string; debit: number; credit: number; lineMemo?: string }> = [];

  lines.push({
    accountId: cashAccountId,
    debit: order.total,
    credit: 0,
    lineMemo: `Order ${order.orderNumber} payment`,
  });
  if (netRevenue > 0)
    lines.push({
      accountId: revenueAccountId,
      debit: 0,
      credit: netRevenue,
      lineMemo: 'Sales revenue (net of discount)',
    });
  if (order.tax > 0)
    lines.push({
      accountId: taxPayableAccountId,
      debit: 0,
      credit: order.tax,
      lineMemo: 'Tax collected',
    });
  if (order.shipping > 0)
    lines.push({
      accountId: shippingIncomeId,
      debit: 0,
      credit: order.shipping,
      lineMemo: 'Shipping fee',
    });

  await postEntry({
    storeId: order.storeId,
    source: 'order',
    sourceId: order.id,
    memo: `Sale — Order ${order.orderNumber}`,
    memoAr: `بيع — طلب ${order.orderNumber}`,
    lines,
    tx,
  });

  // --- COGS side ---
  const cogsLines: typeof lines = [];
  let totalCogs = 0;
  for (const item of order.items) {
    if (item.costPriceDeferred) continue; // backorder — COGS posts at PO receipt
    if (!item.costPrice || item.costPrice <= 0) continue; // products without costPrice yet
    const itemCogs = item.costPrice * item.quantity;
    totalCogs += itemCogs;
    cogsLines.push({
      accountId: cogsAccountId,
      debit: itemCogs,
      credit: 0,
      lineMemo: `COGS — ${item.productName} × ${item.quantity}`,
    });
    cogsLines.push({
      accountId: inventoryAccountId,
      debit: 0,
      credit: itemCogs,
      lineMemo: `Inventory out — ${item.productName} × ${item.quantity}`,
    });
  }
  if (totalCogs > 0) {
    await postEntry({
      storeId: order.storeId,
      source: 'order',
      sourceId: `${order.id}:cogs`,
      memo: `COGS — Order ${order.orderNumber}`,
      memoAr: `تكلفة البضاعة — طلب ${order.orderNumber}`,
      lines: cogsLines,
      tx,
    });
  }
}
```

- [ ] **Step 2: Wire into `OrderService.markPaid` (find the place that transitions paymentStatus → 'paid').**

In `apps/api/src/services/order.service.ts`, locate the `markPaid` method (search: `paymentStatus: 'paid'`). Wrap the existing update in `prisma.$transaction(async (tx) => {…})` if it isn't already, and add this line right after the update:

```ts
import { postOrderPaymentJournal } from './accounting/posting/order-posting';

// inside markPaid, after the order update inside the transaction:
await postOrderPaymentJournal({ tx, orderId: order.id });
```

If markPaid currently does NOT use a transaction, wrap the whole flow. Reference: this is essential — without the transaction guarantee, posting failure can leave a paid order without a journal entry.

- [ ] **Step 3: Typecheck.**

```bash
npm run typecheck -w apps/api
```

Expected: pass.

- [ ] **Step 4: Run the integration test from Task 11 (which we'll write next) — defer to Task 11. For now, smoke-build:**

```bash
npm run build -w apps/api
```

Expected: clean build.

- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/services/accounting/posting/order-posting.ts apps/api/src/services/order.service.ts
git commit -m "feat(accounting): post journal entry on order payment"
```

---

## Task 9: Build `posting/refund-posting.ts` (7th edge in applyRefundEffects)

**Files:**

- Create: `apps/api/src/services/accounting/posting/refund-posting.ts`
- Modify: `apps/api/src/services/order.service.ts` — call `postRefundJournal` inside `applyRefundEffects`

- [ ] **Step 1: Implement the helper.**

`apps/api/src/services/accounting/posting/refund-posting.ts`:

```ts
import type { Prisma } from '@prisma/client';
import { prisma } from '@force/database';
import { reverseEntry } from '../journal.service';

/**
 * Post the GL reversal when a refund is applied. Looks up the original
 * 'order' sourced journal entry for this orderId and posts a mirror entry.
 * Idempotent — if the reversal already exists, returns without re-posting.
 *
 * Partial refunds: in v1 we reverse the entire entry (one refund per order).
 * Partial-refund proportional reversal is a Batch 2 follow-up.
 */
export async function postRefundJournal(args: {
  tx?: Prisma.TransactionClient;
  orderId: string;
  reason?: string;
}): Promise<void> {
  const { orderId, reason } = args;
  const client = args.tx ?? prisma;

  const original = await client.journalEntry.findFirst({
    where: { source: 'order', sourceId: orderId, status: 'posted' },
  });
  if (!original) return; // never posted — nothing to reverse
  if (original.status !== 'posted') return; // already reversed

  await reverseEntry(original.id, reason ?? 'refund applied', args.tx);

  // Also reverse the COGS sibling entry if it exists
  const cogs = await client.journalEntry.findFirst({
    where: { source: 'order', sourceId: `${orderId}:cogs`, status: 'posted' },
  });
  if (cogs) await reverseEntry(cogs.id, reason ?? 'refund applied (cogs reversal)', args.tx);
}
```

- [ ] **Step 2: Wire into `OrderService.applyRefundEffects` (the existing 6-edge fanout).**

In `apps/api/src/services/order.service.ts`, search for `applyRefundEffects`. After the existing side-effect calls (inventory restock, coupon, commission, loyalty, customer profile, notifications), add:

```ts
import { postRefundJournal } from './accounting/posting/refund-posting';

// inside applyRefundEffects, after the existing 6 edges:
await postRefundJournal({ tx, orderId: order.id, reason: refundReason });
```

If `applyRefundEffects` does not pass an explicit tx, pass `prisma` as the implicit fallback — the helper handles both.

- [ ] **Step 3: Typecheck.**

```bash
npm run typecheck -w apps/api
```

Expected: pass.

- [ ] **Step 4: Smoke-build.**

```bash
npm run build -w apps/api
```

Expected: pass.

- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/services/accounting/posting/refund-posting.ts apps/api/src/services/order.service.ts
git commit -m "feat(accounting): reverse journal entry on refund (7th edge)"
```

---

## Task 10: Wire COA seed into store creation

**Files:**

- Modify: `apps/api/src/services/store.service.ts` — call `seedCoaForStore` in `createStore`

- [ ] **Step 1: Add the seed call.**

In `apps/api/src/services/store.service.ts`, find the `createStore` method. After the `prisma.store.create(...)` line, add:

```ts
import { seedCoaForStore } from './accounting/account.service';

// inside createStore, after the store is persisted:
await seedCoaForStore(store.id);
```

If `createStore` runs inside its own transaction, perform the seed inside the same transaction by passing `tx` to a transaction-aware variant. Otherwise the sequential call is fine — `seedCoaForStore` is idempotent.

- [ ] **Step 2: Typecheck + build.**

```bash
npm run typecheck -w apps/api && npm run build -w apps/api
```

Expected: pass.

- [ ] **Step 3: Commit.**

```bash
git add apps/api/src/services/store.service.ts
git commit -m "feat(accounting): seed coa on store creation"
```

---

## Task 11: Integration test — sale posts a balanced journal entry

**Files:**

- Create: `tests/integration/accounting-sale.test.ts`

- [ ] **Step 1: Write the test.**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@force/database';

const API_HOST = process.env.API_HOST || 'http://localhost:4000';
const API_URL = `${API_HOST}/api/v1`;

describe('order payment posts a balanced journal entry', () => {
  let storeId: string;
  let productId: string;

  beforeAll(async () => {
    const store = await prisma.store.create({
      data: {
        name: `sale-test-${Date.now()}`,
        slug: `sale-test-${Date.now()}`,
        ownerId: '00000000-0000-0000-0000-0000000000aa',
      },
    });
    storeId = store.id;
    // seedCoaForStore fires inside createStore in production; mimic it here
    const { seedCoaForStore } =
      await import('../../apps/api/src/services/accounting/account.service');
    await seedCoaForStore(storeId);

    const p = await prisma.product.create({
      data: {
        storeId,
        name: 'Sale Test Product',
        slug: `sale-test-${Date.now()}`,
        price: 5000, // 5 KWD
        costPrice: 3000, // 3 KWD COGS
        inventory: 100,
        status: 'active',
      },
    });
    productId = p.id;
  });

  afterAll(async () => {
    await prisma.journalLine.deleteMany({ where: { entry: { storeId } } });
    await prisma.journalEntry.deleteMany({ where: { storeId } });
    await prisma.orderItem.deleteMany({ where: { order: { storeId } } });
    await prisma.payment.deleteMany({ where: { order: { storeId } } });
    await prisma.order.deleteMany({ where: { storeId } });
    await prisma.product.deleteMany({ where: { storeId } });
    await prisma.account.deleteMany({ where: { storeId } });
    await prisma.store.delete({ where: { id: storeId } });
  });

  it('posts DR Cash / CR Sales + COGS / Inventory on paid order', async () => {
    // Create paid order directly via Prisma (cleaner than full API flow for integration)
    const order = await prisma.order.create({
      data: {
        storeId,
        orderNumber: `SALE-${Date.now()}`,
        status: 'confirmed',
        paymentStatus: 'unpaid', // will mark paid via service
        subtotal: 5000,
        tax: 0,
        shipping: 0,
        discount: 0,
        total: 5000,
        currency: 'KWD',
        shippingAddress: {},
        billingAddress: {},
        items: {
          create: [
            {
              productId,
              productName: 'Sale Test Product',
              quantity: 1,
              price: 5000,
              total: 5000,
              costPrice: 3000,
            },
          ],
        },
        payments: {
          create: [
            {
              provider: 'myfatoorah',
              status: 'completed',
              amount: 5000,
              paidAt: new Date(),
            },
          ],
        },
      },
    });

    const { markPaid } = await import('../../apps/api/src/services/order.service');
    await markPaid(order.id);

    // 2 entries expected: cash/sales + cogs/inventory, both balanced
    const entries = await prisma.journalEntry.findMany({
      where: { storeId, source: 'order' },
      include: { lines: true },
      orderBy: { entryNumber: 'asc' },
    });
    expect(entries.length).toBe(2);

    for (const e of entries) {
      const dr = e.lines.reduce((s, l) => s + l.debit, 0);
      const cr = e.lines.reduce((s, l) => s + l.credit, 0);
      expect(dr).toBe(cr);
      expect(dr).toBeGreaterThan(0);
    }

    const cashSales = entries.find(e => e.sourceId === order.id);
    expect(cashSales?.lines.find(l => l.debit === 5000)).toBeDefined();
    expect(cashSales?.lines.find(l => l.credit === 5000)).toBeDefined();

    const cogs = entries.find(e => e.sourceId === `${order.id}:cogs`);
    expect(cogs?.lines.find(l => l.debit === 3000)).toBeDefined();
    expect(cogs?.lines.find(l => l.credit === 3000)).toBeDefined();
  });

  it('idempotent — re-calling markPaid does not double-post', async () => {
    const order = await prisma.order.findFirst({ where: { storeId, paymentStatus: 'paid' } });
    if (!order) throw new Error('no paid order from previous test');
    const beforeCount = await prisma.journalEntry.count({ where: { storeId, source: 'order' } });

    const { markPaid } = await import('../../apps/api/src/services/order.service');
    await markPaid(order.id);

    const afterCount = await prisma.journalEntry.count({ where: { storeId, source: 'order' } });
    expect(afterCount).toBe(beforeCount);
  });
});
```

- [ ] **Step 2: Start the API + run the test.**

```bash
npm run dev:api &
API_PID=$!
sleep 5
npm run test:integration -- tests/integration/accounting-sale.test.ts
kill $API_PID
```

Expected: PASS (2 tests). If the test fails because `markPaid` doesn't exist or has a different export name, adjust the import to match. If it fails because the order/payment fixture format mismatches the FWB schema (e.g. required fields), edit the test fixture to match.

- [ ] **Step 3: Commit.**

```bash
git add tests/integration/accounting-sale.test.ts
git commit -m "test(accounting): integration — paid order posts balanced journal"
```

---

## Task 12: Integration test — refund reverses the journal entry

**Files:**

- Create: `tests/integration/accounting-refund.test.ts`

- [ ] **Step 1: Write the test.**

```ts
import { describe, it, expect } from 'vitest';
import { prisma } from '@force/database';

describe('refund posts a reversal journal entry', () => {
  it('marks original status=reversed and posts a mirror entry', async () => {
    // Seed: store + COA + paid order (similar fixture pattern as sale test)
    const store = await prisma.store.create({
      data: {
        name: `refund-test-${Date.now()}`,
        slug: `refund-test-${Date.now()}`,
        ownerId: '00000000-0000-0000-0000-0000000000aa',
      },
    });
    const { seedCoaForStore } =
      await import('../../apps/api/src/services/accounting/account.service');
    await seedCoaForStore(store.id);

    const product = await prisma.product.create({
      data: {
        storeId: store.id,
        name: 'Refund Product',
        slug: `refund-${Date.now()}`,
        price: 2000,
        costPrice: 1000,
        inventory: 50,
        status: 'active',
      },
    });

    const order = await prisma.order.create({
      data: {
        storeId: store.id,
        orderNumber: `REFUND-${Date.now()}`,
        status: 'confirmed',
        paymentStatus: 'unpaid',
        subtotal: 2000,
        tax: 0,
        shipping: 0,
        discount: 0,
        total: 2000,
        currency: 'KWD',
        shippingAddress: {},
        billingAddress: {},
        items: {
          create: [
            {
              productId: product.id,
              productName: 'Refund Product',
              quantity: 1,
              price: 2000,
              total: 2000,
              costPrice: 1000,
            },
          ],
        },
        payments: {
          create: [
            { provider: 'myfatoorah', status: 'completed', amount: 2000, paidAt: new Date() },
          ],
        },
      },
    });

    const { markPaid } = await import('../../apps/api/src/services/order.service');
    await markPaid(order.id);

    const { applyRefundEffects } = await import('../../apps/api/src/services/order.service');
    await applyRefundEffects({ orderId: order.id, refundReason: 'customer requested' });

    // Original cash/sales entry → status='reversed'
    const original = await prisma.journalEntry.findFirst({
      where: { storeId: store.id, source: 'order', sourceId: order.id },
    });
    expect(original?.status).toBe('reversed');
    expect(original?.reversedById).toBeTruthy();

    // Mirror entry posted
    const reversal = await prisma.journalEntry.findUnique({
      where: { id: original!.reversedById! },
      include: { lines: true },
    });
    expect(reversal?.reversesId).toBe(original?.id);
    expect(reversal?.lines.find(l => l.credit === 2000)).toBeDefined();
    expect(reversal?.lines.find(l => l.debit === 2000)).toBeDefined();

    // Cleanup
    await prisma.journalLine.deleteMany({ where: { entry: { storeId: store.id } } });
    await prisma.journalEntry.deleteMany({ where: { storeId: store.id } });
    await prisma.orderItem.deleteMany({ where: { order: { storeId: store.id } } });
    await prisma.payment.deleteMany({ where: { order: { storeId: store.id } } });
    await prisma.order.deleteMany({ where: { storeId: store.id } });
    await prisma.product.deleteMany({ where: { storeId: store.id } });
    await prisma.account.deleteMany({ where: { storeId: store.id } });
    await prisma.store.delete({ where: { id: store.id } });
  });
});
```

- [ ] **Step 2: Run with API up.**

```bash
npm run dev:api &
API_PID=$!
sleep 5
npm run test:integration -- tests/integration/accounting-refund.test.ts
kill $API_PID
```

Expected: PASS. If `applyRefundEffects` has a different signature in the actual codebase, adjust the call site to match (and update Task 9's wiring step's signature reference too).

- [ ] **Step 3: Commit.**

```bash
git add tests/integration/accounting-refund.test.ts
git commit -m "test(accounting): integration — refund reverses original journal entry"
```

---

## Task 13: Build `finance.routes.ts` (GET accounts, GET journal)

**Files:**

- Create: `apps/api/src/routes/finance.routes.ts`
- Modify: `apps/api/src/routes/index.ts` — mount the router

- [ ] **Step 1: Implement the routes.**

`apps/api/src/routes/finance.routes.ts`:

```ts
import { Router } from 'express';
import { prisma } from '@force/database';
import { authenticate, authorize, requireStoreAccess } from '../middleware/auth';
import { runInTenantContext } from '../middleware/tenant-context';
import { listAccountsTree } from '../services/accounting/account.service';
import { postEntry } from '../services/accounting/journal.service';
import { z } from 'zod';

const router = Router();

/**
 * GET /stores/:storeId/finance/accounts
 * Returns COA tree grouped by AccountType.
 */
router.get(
  '/:storeId/finance/accounts',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req, res, next) => {
    try {
      const tree = await runInTenantContext(req.params.storeId, () =>
        listAccountsTree(req.params.storeId)
      );
      res.json({ data: tree });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /stores/:storeId/finance/journal?source=&from=&to=&page=&perPage=
 * Paginated journal entry list.
 */
const listQuery = z.object({
  source: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce.number().int().positive().max(200).default(50),
});

router.get(
  '/:storeId/finance/journal',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req, res, next) => {
    try {
      const q = listQuery.parse(req.query);
      const where: any = { storeId: req.params.storeId };
      if (q.source) where.source = q.source;
      if (q.from || q.to) {
        where.postedAt = {};
        if (q.from) where.postedAt.gte = new Date(q.from);
        if (q.to) where.postedAt.lte = new Date(q.to);
      }
      const [items, total] = await runInTenantContext(req.params.storeId, () =>
        Promise.all([
          prisma.journalEntry.findMany({
            where,
            include: {
              lines: {
                include: { account: { select: { code: true, nameEn: true, nameAr: true } } },
              },
            },
            orderBy: { postedAt: 'desc' },
            skip: (q.page - 1) * q.perPage,
            take: q.perPage,
          }),
          prisma.journalEntry.count({ where }),
        ])
      );
      res.json({
        data: items,
        meta: { page: q.page, perPage: q.perPage, total, totalPages: Math.ceil(total / q.perPage) },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /stores/:storeId/finance/journal/:entryId
 * Single entry with full line detail.
 */
router.get(
  '/:storeId/finance/journal/:entryId',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req, res, next) => {
    try {
      const entry = await runInTenantContext(req.params.storeId, () =>
        prisma.journalEntry.findFirst({
          where: { id: req.params.entryId, storeId: req.params.storeId },
          include: { lines: { include: { account: true } }, reversedBy: true, reverses: true },
        })
      );
      if (!entry) return res.status(404).json({ error: 'not_found' });
      res.json({ data: entry });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /stores/:storeId/finance/journal — manual adjusting entry. super_admin only in v1.
 */
const manualEntrySchema = z.object({
  memo: z.string().optional(),
  memoAr: z.string().optional(),
  postedAt: z.string().datetime().optional(),
  lines: z
    .array(
      z.object({
        accountId: z.string().uuid(),
        debit: z.number().int().nonnegative(),
        credit: z.number().int().nonnegative(),
        lineMemo: z.string().optional(),
      })
    )
    .min(2),
});

router.post(
  '/:storeId/finance/journal',
  authenticate,
  authorize('super_admin'), // restricted in v1; promoted to store_admin in Batch 2 if needed
  requireStoreAccess,
  async (req, res, next) => {
    try {
      const body = manualEntrySchema.parse(req.body);
      const entry = await runInTenantContext(req.params.storeId, () =>
        postEntry({
          storeId: req.params.storeId,
          source: 'manual',
          sourceId: undefined,
          memo: body.memo,
          memoAr: body.memoAr,
          postedAt: body.postedAt ? new Date(body.postedAt) : undefined,
          postedBy: (req as any).user?.id,
          lines: body.lines,
        })
      );
      res.status(201).json({ data: entry });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
```

- [ ] **Step 2: Mount in the router index.**

In `apps/api/src/routes/index.ts`, add:

```ts
import financeRoutes from './finance.routes';
// alongside the other router.use(...) calls:
router.use('/stores', financeRoutes);
```

- [ ] **Step 3: Smoke-test with curl (API running).**

```bash
npm run dev:api &
API_PID=$!
sleep 5
# Replace <token> + <storeId> with real values:
curl -s -H "Authorization: Bearer <token>" \
  "http://localhost:4000/api/v1/stores/<storeId>/finance/accounts" | jq '.data | keys'
kill $API_PID
```

Expected: `["assets", "equity", "expenses", "liabilities", "revenue"]`.

- [ ] **Step 4: Typecheck + build.**

```bash
npm run typecheck -w apps/api && npm run build -w apps/api
```

Expected: pass.

- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/routes/finance.routes.ts apps/api/src/routes/index.ts
git commit -m "feat(api): finance routes — accounts tree + journal list/detail/manual"
```

---

## Task 14: Inngest job — `accounting/daily-close`

**Files:**

- Create: `apps/api/src/lib/inngest/functions/accounting-daily-close.ts`
- Modify: `apps/api/src/lib/inngest/index.ts`

- [ ] **Step 1: Implement.**

`apps/api/src/lib/inngest/functions/accounting-daily-close.ts`:

```ts
import type { InngestFunction } from 'inngest';
import { prisma } from '@force/database';
import logger from '../../logger';
import { inngest } from '../client';
import { sendTelegramAlert } from '../../../services/alerts.service';

/**
 * Nightly snapshot of the trial balance for fast P&L queries. Also verifies
 * SUM(DR) = SUM(CR) across ALL entries per store; if drift > 0, P0 alert.
 *
 * Runs at 22:00 UTC = 01:00 Kuwait time (UTC+3).
 */
export const accountingDailyClose: InngestFunction.Any = inngest.createFunction(
  {
    id: 'accounting-daily-close',
    name: 'Accounting daily close',
    retries: 2,
    concurrency: { limit: 1 }, // serialize across all stores
    triggers: [{ cron: '0 22 * * *' }],
  },
  async ({ step }) => {
    const stores = await step.run('list-stores-with-accounting', () =>
      prisma.store.findMany({
        where: { accountingEnabled: true, deletedAt: null },
        select: { id: true, name: true, slug: true },
      })
    );

    let drifts = 0;
    for (const store of stores) {
      const result = await step.run(`drift-${store.id}`, async () => {
        const sums = await prisma.$queryRaw<{ total_debit: bigint; total_credit: bigint }[]>`
          SELECT
            COALESCE(SUM(l.debit), 0)  AS total_debit,
            COALESCE(SUM(l.credit), 0) AS total_credit
          FROM journal_lines l
          JOIN journal_entries e ON e.id = l.entry_id
          WHERE e.store_id = ${store.id}::uuid AND e.status = 'posted'
        `;
        const dr = Number(sums[0].total_debit);
        const cr = Number(sums[0].total_credit);
        return { dr, cr, drift: dr - cr };
      });

      if (result.drift !== 0) {
        drifts += 1;
        await step.run(`alert-${store.id}`, () =>
          sendTelegramAlert({
            severity: 'p0',
            title: `Trial balance drift — ${store.name}`,
            body: `Store ${store.slug}: DR=${result.dr} CR=${result.cr} (drift ${result.drift} fils)`,
          })
        );
      }
    }

    logger.info({ stores: stores.length, drifts }, 'accounting-daily-close completed');
    return { stores: stores.length, drifts };
  }
);
```

- [ ] **Step 2: Register in `inngest/index.ts`.**

In `apps/api/src/lib/inngest/index.ts`:

```ts
import { accountingDailyClose } from './functions/accounting-daily-close';
// add to the exported functions array:
export const functions = [
  // ...existing functions
  accountingDailyClose,
];
```

- [ ] **Step 3: Build.**

```bash
npm run build -w apps/api
```

Expected: pass. If `sendTelegramAlert` has a different signature, adjust the call to match the existing alerts.service.ts interface.

- [ ] **Step 4: Commit.**

```bash
git add apps/api/src/lib/inngest/functions/accounting-daily-close.ts apps/api/src/lib/inngest/index.ts
git commit -m "feat(inngest): accounting daily close + drift detection"
```

---

## Task 15: Inngest job — `accounting/period-reconciliation`

**Files:**

- Create: `apps/api/src/lib/inngest/functions/accounting-period-reconciliation.ts`
- Modify: `apps/api/src/lib/inngest/index.ts`

- [ ] **Step 1: Implement.**

`apps/api/src/lib/inngest/functions/accounting-period-reconciliation.ts`:

```ts
import type { InngestFunction } from 'inngest';
import { prisma } from '@force/database';
import logger from '../../logger';
import { inngest } from '../client';
import { sendTelegramAlert } from '../../../services/alerts.service';

/**
 * Cross-check: SUM(Order.total where paymentStatus=paid, last 24h) MUST equal
 * SUM(JournalLine credit on revenue accounts, same window) for each store.
 *
 * Drift > 0 → P0 alert (the GL has diverged from operational data).
 *
 * Runs at 22:30 UTC = 01:30 Kuwait time.
 */
export const accountingPeriodReconciliation: InngestFunction.Any = inngest.createFunction(
  {
    id: 'accounting-period-reconciliation',
    name: 'Accounting period reconciliation',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: '30 22 * * *' }],
  },
  async ({ step }) => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const stores = await step.run('list-stores', () =>
      prisma.store.findMany({
        where: { accountingEnabled: true, deletedAt: null },
        select: { id: true, slug: true, name: true },
      })
    );

    let drifts = 0;
    for (const store of stores) {
      const ops = await step.run(`ops-${store.id}`, () =>
        prisma.order.aggregate({
          where: { storeId: store.id, paymentStatus: 'paid', createdAt: { gte: since } },
          _sum: { total: true },
        })
      );

      const gl = await step.run(`gl-${store.id}`, async () => {
        const rows = await prisma.$queryRaw<{ total: bigint }[]>`
          SELECT COALESCE(SUM(l.credit), 0) AS total
          FROM journal_lines l
          JOIN journal_entries e ON e.id = l.entry_id
          JOIN accounts a ON a.id = l.account_id
          WHERE e.store_id = ${store.id}::uuid
            AND e.status = 'posted'
            AND e.posted_at >= ${since}
            AND a.code IN ('4000', '4010', '2100') -- revenue + shipping + tax payable
        `;
        return Number(rows[0].total);
      });

      const opsTotal = ops._sum.total ?? 0;
      const drift = opsTotal - gl;
      if (Math.abs(drift) > 0) {
        drifts += 1;
        await step.run(`alert-${store.id}`, () =>
          sendTelegramAlert({
            severity: 'p0',
            title: `GL/operational drift — ${store.name}`,
            body: `Store ${store.slug}: Orders.total=${opsTotal} fils, GL credits=${gl} fils, drift=${drift}`,
          })
        );
      }
    }

    logger.info({ stores: stores.length, drifts }, 'accounting-period-reconciliation completed');
    return { stores: stores.length, drifts };
  }
);
```

- [ ] **Step 2: Register in `inngest/index.ts`.**

```ts
import { accountingPeriodReconciliation } from './functions/accounting-period-reconciliation';
// add to the exported functions array:
export const functions = [
  // ...existing functions
  accountingPeriodReconciliation,
];
```

- [ ] **Step 3: Build.**

```bash
npm run build -w apps/api
```

Expected: pass.

- [ ] **Step 4: Commit.**

```bash
git add apps/api/src/lib/inngest/functions/accounting-period-reconciliation.ts apps/api/src/lib/inngest/index.ts
git commit -m "feat(inngest): accounting period reconciliation"
```

---

## Task 16: Backfill — seed COA for existing stores

**Files:**

- Create: `scripts/seed-coa-for-existing-stores.mjs`

- [ ] **Step 1: Write the script.**

`scripts/seed-coa-for-existing-stores.mjs`:

```js
#!/usr/bin/env node
import { PrismaClient } from '@prisma/client';
import { seedCoaForStore } from '../apps/api/dist/services/accounting/account.service.js';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

async function main() {
  const stores = await prisma.store.findMany({
    where: { accountingEnabled: true, deletedAt: null },
    select: { id: true, slug: true, name: true },
  });
  console.log(`Found ${stores.length} stores eligible for COA seed.`);

  for (const store of stores) {
    if (!APPLY) {
      console.log(`  DRY-RUN: would seed ${store.slug} (${store.name})`);
      continue;
    }
    await seedCoaForStore(store.id);
    console.log(`  ✓ ${store.slug}`);
  }
  await prisma.$disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Dry-run.**

```bash
cd apps/api && npm run build && cd ../..
node scripts/seed-coa-for-existing-stores.mjs
```

Expected: prints `DRY-RUN: would seed …` for each existing store.

- [ ] **Step 3: Apply against local DB.**

```bash
node scripts/seed-coa-for-existing-stores.mjs --apply
```

Expected: prints `✓ <slug>` for each. Re-run is safe (idempotent).

- [ ] **Step 4: Verify in psql.**

```bash
psql "$DATABASE_URL" -c "SELECT store_id, COUNT(*) FROM accounts GROUP BY store_id ORDER BY count DESC LIMIT 5;"
```

Expected: each store has 27 accounts.

- [ ] **Step 5: Commit.**

```bash
git add scripts/seed-coa-for-existing-stores.mjs
git commit -m "chore(accounting): backfill script — seed coa for existing stores"
```

---

## Task 17: Admin page — `/finance/accounts` (COA tree, read-only v1)

**Files:**

- Create: `apps/admin/src/app/stores/[id]/finance/accounts/page.tsx`
- Modify: `apps/admin/messages/en.json` + `messages/ar.json` (add `finance.accounts.*` keys)

- [ ] **Step 1: Add i18n keys.**

In `apps/admin/messages/en.json`:

```json
{
  "finance": {
    "accounts": {
      "title": "Chart of Accounts",
      "description": "All ledger accounts grouped by type. System accounts cannot be edited or deleted.",
      "type": {
        "asset": "Assets",
        "liability": "Liabilities",
        "equity": "Equity",
        "revenue": "Revenue",
        "expense": "Expenses"
      },
      "system": "System",
      "code": "Code",
      "name": "Name"
    },
    "journal": {
      "title": "Journal Entries",
      "description": "Every financial event posts a balanced journal entry here.",
      "entryNumber": "Entry #",
      "postedAt": "Date",
      "source": "Source",
      "memo": "Memo",
      "debit": "Debit",
      "credit": "Credit",
      "reversed": "Reversed",
      "viewDetail": "View"
    }
  }
}
```

Mirror to `apps/admin/messages/ar.json`:

```json
{
  "finance": {
    "accounts": {
      "title": "دليل الحسابات",
      "description": "كل الحسابات الدفترية مجمّعة حسب النوع. لا يمكن تعديل أو حذف الحسابات النظامية.",
      "type": {
        "asset": "الأصول",
        "liability": "الالتزامات",
        "equity": "حقوق الملكية",
        "revenue": "الإيرادات",
        "expense": "المصروفات"
      },
      "system": "نظامي",
      "code": "الرمز",
      "name": "الاسم"
    },
    "journal": {
      "title": "قيود اليومية",
      "description": "كل عملية مالية تنشئ قيد دفتري متوازن هنا.",
      "entryNumber": "رقم القيد",
      "postedAt": "التاريخ",
      "source": "المصدر",
      "memo": "البيان",
      "debit": "مدين",
      "credit": "دائن",
      "reversed": "مُلغى",
      "viewDetail": "عرض"
    }
  }
}
```

- [ ] **Step 2: Implement the page.**

`apps/admin/src/app/stores/[id]/finance/accounts/page.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { apiGet } from '@/lib/api';

type Account = {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string | null;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  isSystem: boolean;
  children?: Account[];
};

type Tree = Record<'assets' | 'liabilities' | 'equity' | 'revenue' | 'expenses', Account[]>;

const GROUPS: { key: keyof Tree; typeKey: string }[] = [
  { key: 'assets', typeKey: 'asset' },
  { key: 'liabilities', typeKey: 'liability' },
  { key: 'equity', typeKey: 'equity' },
  { key: 'revenue', typeKey: 'revenue' },
  { key: 'expenses', typeKey: 'expense' },
];

export default function AccountsPage() {
  const { id: storeId } = useParams<{ id: string }>();
  const t = useTranslations('finance.accounts');
  const [tree, setTree] = useState<Tree | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ data: Tree }>(`/stores/${storeId}/finance/accounts`)
      .then(r => setTree(r.data))
      .catch(e => setError(e?.message ?? 'error'));
  }, [storeId]);

  if (error) return <div className="p-6 text-red-600">{error}</div>;
  if (!tree) return <div className="p-6">Loading…</div>;

  return (
    <div className="p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </header>

      {GROUPS.map(({ key, typeKey }) => (
        <section key={key}>
          <h2 className="text-lg font-semibold mb-2">{t(`type.${typeKey}`)}</h2>
          <table className="w-full text-sm border border-border rounded">
            <thead className="bg-muted/30">
              <tr>
                <th className="text-start px-3 py-2 w-24">{t('code')}</th>
                <th className="text-start px-3 py-2">{t('name')}</th>
                <th className="text-end px-3 py-2 w-24">{t('system')}</th>
              </tr>
            </thead>
            <tbody>
              {tree[key].map(a => (
                <tr key={a.id} className="border-t border-border/40">
                  <td className="px-3 py-2 font-mono">{a.code}</td>
                  <td className="px-3 py-2">
                    {a.nameEn}
                    {a.nameAr ? (
                      <span className="text-muted-foreground ms-2" dir="rtl">
                        — {a.nameAr}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-end">{a.isSystem ? '✓' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Smoke-test in browser.**

```bash
npm run dev:admin
```

Open `http://localhost:3001/stores/<id>/finance/accounts`. Expected: tree renders with 27 accounts grouped by type; system column shows ✓ on all; AR labels visible in RTL mode.

- [ ] **Step 4: Build.**

```bash
npm run build -w apps/admin
```

Expected: pass (per `feedback-fwb-vercel-strict-ts-vs-local` — local build, not just typecheck).

- [ ] **Step 5: Commit.**

```bash
git add apps/admin/src/app/stores/\[id\]/finance/accounts/page.tsx apps/admin/messages/
git commit -m "feat(admin): finance — chart of accounts read-only viewer"
```

---

## Task 18: Admin page — `/finance/journal` (entry list + drill-in)

**Files:**

- Create: `apps/admin/src/app/stores/[id]/finance/journal/page.tsx`
- Create: `apps/admin/src/app/stores/[id]/finance/journal/[entryId]/page.tsx`

- [ ] **Step 1: List page.**

`apps/admin/src/app/stores/[id]/finance/journal/page.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { apiGet } from '@/lib/api';

type Entry = {
  id: string;
  entryNumber: string;
  postedAt: string;
  source: string;
  memo: string | null;
  status: 'posted' | 'reversed' | 'draft';
  lines: { debit: number; credit: number }[];
};

export default function JournalListPage() {
  const { id: storeId } = useParams<{ id: string }>();
  const t = useTranslations('finance.journal');
  const [entries, setEntries] = useState<Entry[]>([]);

  useEffect(() => {
    apiGet<{ data: Entry[] }>(`/stores/${storeId}/finance/journal?perPage=100`).then(r =>
      setEntries(r.data)
    );
  }, [storeId]);

  return (
    <div className="p-6 space-y-4">
      <header>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </header>
      <table className="w-full text-sm border border-border rounded">
        <thead className="bg-muted/30">
          <tr>
            <th className="text-start px-3 py-2">{t('entryNumber')}</th>
            <th className="text-start px-3 py-2">{t('postedAt')}</th>
            <th className="text-start px-3 py-2">{t('source')}</th>
            <th className="text-start px-3 py-2">{t('memo')}</th>
            <th className="text-end px-3 py-2">{t('debit')}</th>
            <th className="text-end px-3 py-2">{t('credit')}</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {entries.map(e => {
            const dr = e.lines.reduce((s, l) => s + l.debit, 0);
            const cr = e.lines.reduce((s, l) => s + l.credit, 0);
            return (
              <tr
                key={e.id}
                className={`border-t border-border/40 ${e.status === 'reversed' ? 'opacity-60 line-through' : ''}`}
              >
                <td className="px-3 py-2 font-mono">{e.entryNumber}</td>
                <td className="px-3 py-2">{new Date(e.postedAt).toLocaleString()}</td>
                <td className="px-3 py-2">{e.source}</td>
                <td className="px-3 py-2">{e.memo}</td>
                <td className="px-3 py-2 text-end font-mono">{(dr / 1000).toFixed(3)}</td>
                <td className="px-3 py-2 text-end font-mono">{(cr / 1000).toFixed(3)}</td>
                <td className="px-3 py-2 text-end">
                  <Link
                    href={`/stores/${storeId}/finance/journal/${e.id}`}
                    className="text-primary underline"
                  >
                    {t('viewDetail')}
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Detail page.**

`apps/admin/src/app/stores/[id]/finance/journal/[entryId]/page.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { apiGet } from '@/lib/api';

type Line = {
  id: string;
  debit: number;
  credit: number;
  lineMemo: string | null;
  account: { code: string; nameEn: string; nameAr: string | null };
};
type Entry = {
  id: string;
  entryNumber: string;
  postedAt: string;
  source: string;
  memo: string | null;
  status: 'posted' | 'reversed' | 'draft';
  reversedBy: { entryNumber: string } | null;
  reverses: { entryNumber: string } | null;
  lines: Line[];
};

export default function JournalDetailPage() {
  const { id: storeId, entryId } = useParams<{ id: string; entryId: string }>();
  const t = useTranslations('finance.journal');
  const [entry, setEntry] = useState<Entry | null>(null);

  useEffect(() => {
    apiGet<{ data: Entry }>(`/stores/${storeId}/finance/journal/${entryId}`).then(r =>
      setEntry(r.data)
    );
  }, [storeId, entryId]);

  if (!entry) return <div className="p-6">Loading…</div>;

  return (
    <div className="p-6 space-y-4">
      <header>
        <h1 className="text-2xl font-bold">{entry.entryNumber}</h1>
        <p className="text-sm text-muted-foreground">
          {new Date(entry.postedAt).toLocaleString()} · {entry.source}
        </p>
        {entry.memo && <p className="mt-2">{entry.memo}</p>}
        {entry.status === 'reversed' && entry.reversedBy && (
          <p className="text-sm text-yellow-700">
            {t('reversed')} → {entry.reversedBy.entryNumber}
          </p>
        )}
        {entry.reverses && (
          <p className="text-sm text-yellow-700">Reverses {entry.reverses.entryNumber}</p>
        )}
      </header>
      <table className="w-full text-sm border border-border rounded">
        <thead className="bg-muted/30">
          <tr>
            <th className="text-start px-3 py-2 w-20">{t('debit')}</th>
            <th className="text-end px-3 py-2 w-32">{t('debit')}</th>
            <th className="text-end px-3 py-2 w-32">{t('credit')}</th>
            <th className="text-start px-3 py-2">{t('memo')}</th>
          </tr>
        </thead>
        <tbody>
          {entry.lines.map(l => (
            <tr key={l.id} className="border-t border-border/40">
              <td className="px-3 py-2 font-mono">{l.account.code}</td>
              <td className="px-3 py-2 text-end font-mono">
                {l.debit > 0 ? (l.debit / 1000).toFixed(3) : ''}
              </td>
              <td className="px-3 py-2 text-end font-mono">
                {l.credit > 0 ? (l.credit / 1000).toFixed(3) : ''}
              </td>
              <td className="px-3 py-2">{l.lineMemo ?? l.account.nameEn}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: Build admin.**

```bash
npm run build -w apps/admin
```

Expected: pass.

- [ ] **Step 4: Smoke in browser.**

Open `http://localhost:3001/stores/<id>/finance/journal` — list renders; click an entry → detail renders with DR/CR aligned.

- [ ] **Step 5: Commit.**

```bash
git add apps/admin/src/app/stores/\[id\]/finance/
git commit -m "feat(admin): finance — journal list + detail viewer"
```

---

## Task 19: Add Finance sidebar group in admin nav

**Files:**

- Modify: the existing admin sidebar component (usually `apps/admin/src/components/Sidebar.tsx`, `Layout.tsx`, or `app/stores/[id]/layout.tsx` — find the navigation array)

- [ ] **Step 1: Locate the sidebar nav array.**

```bash
grep -rn "stores/\[id\]/" apps/admin/src/components/ apps/admin/src/app/stores/\[id\]/layout.tsx 2>/dev/null | grep -iE "nav|sidebar|menu" | head -10
```

Expected: a few hits showing where store-scoped navigation entries are defined. Open the relevant file.

- [ ] **Step 2: Add the Finance group entries.**

In whichever file owns the store-sidebar nav array, add a new group:

```tsx
{
  groupLabel: 'Finance', // or use t('nav.finance')
  groupLabelAr: 'المالية',
  items: [
    { href: `/stores/${storeId}/finance/accounts`, label: 'Chart of Accounts', labelAr: 'دليل الحسابات', icon: 'BookOpen' },
    { href: `/stores/${storeId}/finance/journal`,  label: 'Journal',          labelAr: 'يومية',          icon: 'List' },
  ],
}
```

Match the exact pattern used by other groups in that file (icon name, key conventions, i18n key vs literal). Insert the group between existing groups in the order that mirrors operational flow — likely after "Catalog" and "Orders".

- [ ] **Step 3: Build.**

```bash
npm run build -w apps/admin
```

Expected: pass.

- [ ] **Step 4: Smoke-test in browser.**

Reload admin sidebar — Finance group with Accounts + Journal entries visible. Click each → page renders.

- [ ] **Step 5: Commit.**

```bash
git add apps/admin/src/components/ apps/admin/src/app/stores/\[id\]/
git commit -m "feat(admin): add finance sidebar group (accounts, journal)"
```

---

## Task 20: Integration test — idempotent webhook re-fire

**Files:**

- Create: `tests/integration/accounting-idempotency.test.ts`

- [ ] **Step 1: Write the test.**

```ts
import { describe, it, expect } from 'vitest';
import { prisma } from '@force/database';

describe('webhook re-fire does not double-post', () => {
  it('idempotent journal post via (source, sourceId)', async () => {
    const store = await prisma.store.create({
      data: {
        name: `idem-${Date.now()}`,
        slug: `idem-${Date.now()}`,
        ownerId: '00000000-0000-0000-0000-0000000000aa',
      },
    });
    const { seedCoaForStore } =
      await import('../../apps/api/src/services/accounting/account.service');
    await seedCoaForStore(store.id);

    const product = await prisma.product.create({
      data: {
        storeId: store.id,
        name: 'P',
        slug: `p-${Date.now()}`,
        price: 1000,
        costPrice: 500,
        inventory: 10,
        status: 'active',
      },
    });

    const order = await prisma.order.create({
      data: {
        storeId: store.id,
        orderNumber: `IDEM-${Date.now()}`,
        status: 'confirmed',
        paymentStatus: 'unpaid',
        subtotal: 1000,
        tax: 0,
        shipping: 0,
        discount: 0,
        total: 1000,
        currency: 'KWD',
        shippingAddress: {},
        billingAddress: {},
        items: {
          create: [
            {
              productId: product.id,
              productName: 'P',
              quantity: 1,
              price: 1000,
              total: 1000,
              costPrice: 500,
            },
          ],
        },
        payments: {
          create: [
            { provider: 'myfatoorah', status: 'completed', amount: 1000, paidAt: new Date() },
          ],
        },
      },
    });

    const { markPaid } = await import('../../apps/api/src/services/order.service');

    // Fire 5 times in parallel (simulating retried webhook + concurrent reconcile)
    await Promise.all(Array.from({ length: 5 }, () => markPaid(order.id)));

    const entries = await prisma.journalEntry.findMany({
      where: { storeId: store.id, source: 'order' },
    });
    // Expect exactly 2 entries (cash/sales + cogs) — no duplicates.
    expect(entries.length).toBe(2);

    // Cleanup
    await prisma.journalLine.deleteMany({ where: { entry: { storeId: store.id } } });
    await prisma.journalEntry.deleteMany({ where: { storeId: store.id } });
    await prisma.orderItem.deleteMany({ where: { order: { storeId: store.id } } });
    await prisma.payment.deleteMany({ where: { order: { storeId: store.id } } });
    await prisma.order.deleteMany({ where: { storeId: store.id } });
    await prisma.product.deleteMany({ where: { storeId: store.id } });
    await prisma.account.deleteMany({ where: { storeId: store.id } });
    await prisma.store.delete({ where: { id: store.id } });
  });
});
```

- [ ] **Step 2: Run with API up.**

```bash
npm run dev:api &
API_PID=$!
sleep 5
npm run test:integration -- tests/integration/accounting-idempotency.test.ts
kill $API_PID
```

Expected: PASS — exactly 2 entries despite 5 concurrent `markPaid` calls.

- [ ] **Step 3: Commit.**

```bash
git add tests/integration/accounting-idempotency.test.ts
git commit -m "test(accounting): integration — idempotent post on concurrent calls"
```

---

## Task 21: Full validation pass

- [ ] **Step 1: TypeCheck across workspaces.**

```bash
npm run typecheck
```

Expected: pass.

- [ ] **Step 2: Lint.**

```bash
npm run lint
```

Expected: pass (or only pre-existing warnings, no new errors from this batch).

- [ ] **Step 3: Full unit + integration test suite.**

```bash
npm run dev:api &
API_PID=$!
sleep 5
npm run test:unit && npm run test:integration
kill $API_PID
```

Expected: all green.

- [ ] **Step 4: `npm audit` — must be 0/0/0/0.**

```bash
npm audit
```

Expected: `found 0 vulnerabilities`. If any new dep introduced a vulnerability, add an `overrides` block in package.json per the standing policy in `feedback-new-project-security-baseline.md`.

- [ ] **Step 5: Build both Vercel apps (Vercel strict TS rule).**

```bash
npm run build -w apps/admin && npm run build -w apps/web
```

Expected: pass. Per `feedback-fwb-vercel-strict-ts-vs-local`, local typecheck is not sufficient — `next build` enforces `noUnusedParameters` + `noUnusedLocals` as errors. If a build fails on unused params/locals introduced by this batch, prefix with `_` or remove.

- [ ] **Step 6: Refresh graphify.**

```bash
graphify update .
```

Expected: incremental update, no API cost. Then:

```bash
git add graphify-out/
git commit -m "chore(graphify): refresh after accounting batch 1"
```

(If a `.graphify_polish_chunk_*.json` file already exists from another session, leave it alone — only stage `graph.json` + `GRAPH_REPORT.md` + `graph.html`.)

---

## Task 22: Memory + vault update (per Ahmad's standing rule)

- [ ] **Step 1: Write a project memory entry.**

`~/.claude/projects/-Users-ahmadsharaf-Desktop-projects-force-website-builder/memory/feature-accounting-batch-1.md`:

```markdown
---
name: feature-accounting-batch-1
description: FWB accounting foundations shipped 2026-05-19 — Account/JournalEntry/JournalLine + sync posting on order/refund + COA seed + admin viewer + daily reconcile jobs
metadata:
  type: project
---

Batch 1 of 4 for the accounting + stock + insights subsystem (spec at `docs/superpowers/specs/2026-05-19-fwb-accounting-stock-design.md`).

**What shipped:**

- 4 new Prisma models: `Account`, `JournalEntry`, `JournalLine`, `Sequence`
- DB-level CHECK + deferred DR=CR trigger guarantees no unbalanced entry can ever commit
- `apps/api/src/services/accounting/` — `account.service` (seed/CRUD), `journal.service` (post/reverse with idempotency), `posting/order-posting`, `posting/refund-posting`
- Sync posting wired into `OrderService.markPaid` + `applyRefundEffects` (7th edge)
- `/finance/accounts` + `/finance/journal` admin pages (read-only)
- Inngest: `accounting-daily-close` (1am KW) + `accounting-period-reconciliation` (1:30am KW) — both fire P0 Telegram on drift
- COA backfill script + per-store COA seeded on store creation

**Why:** foundation for Batches 2-4 (stock+backorders, smart layer, insights/BI).

**Apply when:** building on top of this — Batch 2 schema starts adding PO/Supplier/Backorder etc. against this foundation.
```

- [ ] **Step 2: Update MEMORY.md index.**

`~/.claude/projects/-Users-ahmadsharaf-Desktop-projects-force-website-builder/memory/MEMORY.md` — add line under the `## Force Website Builder` (or equivalent) section:

```markdown
- [feature-accounting-batch-1.md](feature-accounting-batch-1.md) — FWB accounting foundations shipped 2026-05-19 — Account/JournalEntry/JournalLine + sync posting on order/refund + COA seed + admin viewer + daily reconcile jobs
```

- [ ] **Step 3: Update vault project note.**

`/Users/ahmadsharaf/Desktop/projects/calude code meomry/wiki/projects/force-website-builder.md` — add a callout under the latest dated section:

```markdown
## 2026-05-19 — Accounting batch 1 (foundations)

Shipped commit `<HEAD-sha-of-batch-1>`. Schema + sync posting + COA seed + admin viewer. Spec: `docs/superpowers/specs/2026-05-19-fwb-accounting-stock-design.md`. Batches 2-4 (stock+backorders, smart layer, insights) to follow in separate sessions.
```

Bump frontmatter `updated:` to today's ISO date.

- [ ] **Step 4: Fire the memory pipeline (background).**

```bash
nohup ~/.claude/scripts/update-memory-pipeline.sh all > /dev/null 2>&1 &
disown
```

Expected: background process kicks off; check `/tmp/update-memory-*.log` later.

- [ ] **Step 5: Commit memory + vault changes (vault has its own repo).**

```bash
# Project memory + index — local only, no git
# (the pipeline mirrors them into the vault automatically)

# Vault commit happens inside the pipeline; we don't manually push from here
echo "memory + vault entries written; pipeline handles commit/push"
```

---

## Self-Review (run BEFORE handing off for execution)

**Spec coverage:**

- Part 1.1 Account/JournalEntry/JournalLine ✓ Tasks 1-2
- Part 1.3 Store extensions ✓ Task 1 Step 2
- Part 1.4 CHECK + DR=CR trigger + RLS + Sequence ✓ Task 2
- Part 2.1 sync posting on order/refund/PO-receive — order ✓ Task 8, refund ✓ Task 9. **PO-receive deferred to Batch 2 — flagged in plan header.**
- Part 2.2 async: daily-close ✓ Task 14, period-reconciliation ✓ Task 15. **Other async jobs (analytics, reorder, dead-stock, profit-anomaly, expense-ocr) deferred to Batches 3/4 — flagged in plan header.**
- Part 5 KW COA template ✓ Task 5
- Part 6 admin pages: accounts ✓ Task 17, journal ✓ Task 18. **dashboard/expenses/reports/tax deferred to Batches 2/3 — flagged in plan header.**
- Part 8 KW specifics (fils, retention via no-deletedAt, bilingual) ✓ Tasks 1, 5, 17, 18
- Acceptance #1 (sale posts balanced entry), #2 (refund posts reversal), #12 (no silent disappearance) ✓ Tasks 11-12, 20

**Gaps to flag to Ahmad in handoff:** PO-receive posting + remaining async jobs + remaining admin pages are explicit Batch-2/3/4 scope per the spec's Phasing section. Batch 1 is complete for what it covers.

**Placeholder scan:** no TBDs / TODOs / placeholders found in the plan body. All file paths absolute or repo-relative + complete code in every step.

**Type consistency:** `postEntry` signature in Task 7 matches all call sites in Tasks 8, 9, 11, 12, 13, 20. `seedCoaForStore` matches Tasks 6, 10, 11, 12, 16, 20. `nextSequence` matches Tasks 4 and 7.

**Scope check:** 22 tasks. Each is independently shippable + commitable. Total commits: ~22. Estimated time: 6-9 hours for one engineer or one Sonnet subagent loop.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-19-fwb-accounting-batch-1-foundations.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh Sonnet subagent per task, review between tasks, fast iteration. Best for FWB given the 22-task scope and the existing pattern of one-task-per-commit.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints. Cheaper on token overhead but slower.

**Which approach?**

After this batch ships + Ahmad verifies, the plans for Batches 2-4 get authored just-in-time against the freshly-shipped Batch 1 codebase so each plan reflects the actual state (not the spec-state) of the schema.
