# Bank Reconciliation — Implementation Plan

**Date:** 2026-06-15  
**Feature:** `accounting.bank_reconcile` (Enterprise add-on)  
**Branch:** `feat/bank-reconciliation`

## Goal

Make the brochure claim true: "Import your bank statement (CSV or OFX) and the
platform automatically matches transactions against your ledger; manual override
for any unmatched item."

## Money-path guarantees

- **Integer fils only** — no floats anywhere. Decimal strings parsed via string
  arithmetic (`Math.round(parseFloat(s) * 1000)`). KWD 12.345 → 12345 fils.
- **Idempotent imports** — `(storeId, glAccountId, date, amountFils, externalRef)`
  unique constraint; re-importing the same statement is a no-op per row.
- **Transactional** — statement creation + all rows inserted in one Prisma
  `$transaction`. Auto-match runs after, in a separate transaction per update.

## Layer plan

### 1. Prisma schema (additive migration)

New models:

**BankStatement**

- id, storeId, glAccountId (FK → accounts), fileName, importedAt, periodStart,
  periodEnd, status (pending | reconciling | reconciled), createdAt
- Relations: store, account, transactions[]
- Indexes: storeId, status

**BankTransaction**

- id, statementId, storeId, date, description, amountFils (Int), direction
  (debit | credit), externalRef (nullable), matchedJournalEntryId (nullable FK),
  matchStatus (unmatched | auto_matched | manual_matched | ignored),
  confidence (Int default 0), createdAt
- Unique: (storeId, statementId, date, amountFils, externalRef) — dedupe key
  NOTE: externalRef nullable means we composite-nullify with hash fallback
- Indexes: statementId, matchStatus, date

RLS policies mirror existing tenant table pattern.

### 2. Parsers

**CSV parser** (`parseStatementCsv`):

- Auto-detect header row; support English + Arabic column names
- Map: date (ISO/d-m-y/m-d-y), description, debit, credit, reference/fitid
- Output: `ParsedRow[]` with amountFils (Int) and direction
- NO float math — parse decimal string → `Math.round(n * 1000)`

**OFX parser** (`parseStatementOfx`):

- Hand-rolled SGML/XML reader — no heavy dep
- Extract `<STMTTRN>` blocks: DTPOSTED, TRNAMT, FITID, NAME/MEMO
- Sign: positive TRNAMT → credit; negative → debit (standard OFX convention)
- Same fils conversion

### 3. Matching engine (`bank-reconcile.service.ts`)

For each bank transaction, find candidate JournalLines where:

- `ABS(line.debit - tx.amountFils) < 5` OR `ABS(line.credit - tx.amountFils) < 5`
  (direction-matched — debit tx → ledger debit, credit tx → ledger credit)
- `ABS(entry.postedAt - tx.date) <= 3 days`
- `entry.storeId = tx.storeId`
- `entry.status = 'posted'`
- NOT already matched to another bank transaction

Rules:

- 0 candidates → `unmatched`
- 1 candidate → `auto_matched` (confidence = amount-match score 0–100)
- 2+ candidates → `unmatched` (ambiguous — never auto-match)
- A ledger entry already matched to a bank row cannot be re-matched

### 4. API routes (appended to finance.routes.ts)

All behind: `authenticate → requireMfaEnrolled → authorize('store_admin','super_admin') → requireStoreAccess → requireFeature('accounting.bank_reconcile')`

```
POST   /:storeId/finance/bank-statements          import (multipart)
GET    /:storeId/finance/bank-statements          list statements (paginated)
GET    /:storeId/finance/bank-statements/:sid     statement detail + summary
GET    /:storeId/finance/bank-statements/:sid/transactions  paginated tx list
POST   /:storeId/finance/bank-statements/:sid/auto-match   run/re-run matching
PATCH  /:storeId/finance/bank-statements/:sid/transactions/:tid  manual override
DELETE /:storeId/finance/bank-statements/:sid               delete statement
```

Import uses `multer` (memory storage, 5MB limit, csv/ofx only). Zod validates
all body + query params.

### 5. Admin UI (`apps/admin/src/app/stores/[id]/finance/bank-reconciliation/`)

Pages:

- `page.tsx` — statement list with status badges + "Import" button
- `import/page.tsx` — file upload + GL account select + parsed preview table
- `[statementId]/page.tsx` — reconciliation view: two-panel (bank tx | ledger
  match), match-status badges (auto/manual/unmatched/ignored), manual-match
  action, summary totals

### 6. Tests (`tests/unit/bank-reconciliation.test.ts`)

Unit tests (no DB):

- CSV parse: standard EN headers, Arabic headers, malformed rows skipped
- OFX parse: SGML format, XML format, signed amounts
- Fils precision: 12.345 KWD → 12345, 1.000 → 1000, 0.001 → 1
- Matching: exact match, ±3-day tolerance, ambiguous → unmatched, no double-match
- Idempotent: duplicate row returns existing (dedupe key logic)

### 7. Doc parity (same PR)

- `packages/shared/src/features.ts` — tier stays `addon` (it's Enterprise-gated)
- `docs/business/02-feature-catalog.md` — bank rec section → REAL
- `docs/business/plan-feature-matrix.md` — bank_reconcile row updated
- `ROADMAP.md` — bank rec entry → done

## Commit order (incremental)

1. Plan doc
2. Schema + migration
3. Parser service + unit tests
4. Matching engine (service + tests)
5. API routes
6. Admin UI
7. Doc parity
8. Format + final cleanup
