# Multi-Currency FX Capture + Automatic KWD Conversion

**Date:** 2026-06-15
**Branch:** feat/multi-currency
**Feature gate:** `accounting.multi_currency` (Enterprise / addon — already in features.ts)

---

## Problem

`Expense.currency` and `JournalLine.currency` are display-only string labels.
No FX rate is stored; no KWD conversion is computed.
The brochure claim "Track non-KWD transactions with FX rates and automatic KWD conversion" is false today.

---

## Design Goals

1. KWD-only behaviour is **byte-identical to before** — zero risk for existing stores.
2. All amounts already stored as integer minor units (fils, 1 KWD = 1000 fils). This contract is unchanged.
3. No binary floats ever touch money. FX rate is stored as a PostgreSQL `Decimal` (numeric(16,8)) — exact rational arithmetic, no IEEE 754 rounding.
4. Reporting always stays in KWD fils — existing P&L / trial-balance / balance-sheet are untouched.

---

## FX Rate Representation

```
fxRate: Decimal (Prisma Decimal = PostgreSQL numeric(16,8))
Meaning: 1 unit of `currency` = fxRate KWD
Example: 1 USD = 0.30700000 KWD → fxRate = 0.307
```

**Rounding rule: half-up** to nearest integer fil.

```
kwdFils = ROUND_HALF_UP(originalAmountMinorUnits × fxRate)
```

Implementation uses JavaScript's `Math.round()` — which is half-up for positive numbers — applied to the product of `originalAmount * Number(fxRate)`. Because `fxRate` is a Decimal from Prisma (serialised as a string), we parse it with `Number()` before multiplying. The product is always positive; `Math.round` gives the correct half-up result.

**KWD passthrough**: when `currency === 'KWD'`, `originalAmount` = `amount`, `fxRate` = `1.000000000` stored but ignored in conversion — `amount` is already in fils.

---

## Schema Changes (additive, non-breaking)

### `JournalLine` — new optional columns

```sql
fxRate           Decimal?  @default(1)   -- numeric(16,8): 1 unit foreign → KWD
originalAmount   Int?      @default(0)   -- minor units of `currency` (fils for KWD)
```

- Existing `currency` column stays (already `@default("KWD")`).
- Existing `debit`/`credit` stay in KWD fils — unchanged.
- For KWD lines: `currency='KWD'`, `fxRate=1`, `originalAmount=debit` (or `credit`).
- For non-KWD lines: `currency='USD'`, `fxRate=0.307`, `originalAmount=3100` (=31.00 USD),
  `debit=ceil(3100 × 0.307)` = `952` fils = 0.952 KWD.

### `Expense` — new optional columns

```sql
fxRate           Decimal?  @default(1)   -- same as JournalLine
originalAmount   Int?      @default(0)   -- minor units of original currency
```

- Existing `amount`, `taxAmount`, `total`, `currency` unchanged.
- When non-KWD: `amount`/`total` carry the KWD-converted fils; `originalAmount` carries the raw foreign amount in minor units; `fxRate` carries the rate.

---

## Service Changes

### `journal.service.ts` — `JournalLineInput` / `postEntry`

```typescript
interface JournalLineInput {
  // existing
  accountId;
  debit;
  credit;
  lineMemo?;
  lineMemoAr?;
  refTable?;
  refId?;
  // new optional
  currency?: string; // ISO-4217, defaults 'KWD'
  fxRate?: Decimal | number; // defaults 1
  originalAmount?: number; // minor units in foreign currency, defaults debit|credit
}
```

When `currency !== 'KWD'`, `postEntry` passes `fxRate` and `originalAmount` through to the DB row. The **caller is responsible for pre-computing KWD `debit`/`credit`** using `convertToKwd()` from `@ebda/shared`.

`createData.lines.create` now includes `currency`, `fxRate`, `originalAmount`.

### New util: `packages/shared/src/utils/accounting.ts` — `convertToKwd()`

```typescript
function convertToKwd(originalAmount: number, fxRate: number | Decimal): number {
  return Math.round(originalAmount * Number(fxRate));
}
```

Simple, tested, no imports.

### `expense.service.ts` — `CreateExpenseInput`

```typescript
interface CreateExpenseInput {
  // existing
  ...
  currency?: string;
  // NEW
  fxRate?: number;           // required when currency !== 'KWD'
  originalAmount?: number;   // minor units in original currency
}
```

`createExpense` logic:

1. If `currency === 'KWD'` or absent → `fxRate = 1`, `originalAmount = input.amount`, `amount` as-is.
2. If `currency !== 'KWD'` → validate `fxRate > 0`, compute `amountKwd = convertToKwd(input.originalAmount ?? input.amount, fxRate)`, store `amount = amountKwd`, store `total = amountKwd + taxKwd`, store `fxRate` and `originalAmount`.

### `expense-ocr.service.ts` — non-KWD path

OCR already detects `currency !== 'KWD'` and adds a note "manual review required". Now:

- The draft expense stores `currency` and `originalAmount` (the OCR-extracted fils).
- `fxRate` defaults to `1` (merchant must review and update it).
- The notes will say "Non-KWD receipt — please set the FX rate before approving."
- When merchant edits the expense (via UI), they can supply `fxRate`; the UI re-computes the KWD total live.

### `posting/expense-posting.ts`

No change needed — it reads `expense.total` (already KWD fils) and posts it. The KWD conversion has already happened at create/update time.

### `posting/order-posting.ts` / `posting/po-receive-posting.ts`

Orders and POs are always in KWD (the store's payment rails are KWD). No change needed for v1. FX journaling for multi-currency orders is out of scope for this PR.

---

## API Changes

### `expenses.routes.ts` — `createSchema`

```typescript
fxRate: z.number().positive().optional(),
originalAmount: z.number().int().nonnegative().optional(),
```

Validation rule: `if currency !== 'KWD' && currency is set → fxRate is REQUIRED`.

### `finance.routes.ts` — manual journal entry schema

```typescript
lines: z.array(z.object({
  // existing
  accountId, debit, credit, lineMemo?
  // new
  currency?: z.string().length(3),
  fxRate?: z.number().positive(),
  originalAmount?: z.number().int().nonnegative(),
}))
```

Gate: only when `requireFeature('accounting.multi_currency')` is active. If the feature is absent, the new fields are silently stripped (KWD-only fallback).

### New endpoint: `GET/POST /:storeId/finance/fx-rates`

A simple rate registry: merchant records the day's rate for a currency pair.

```
POST { currency: 'USD', rate: 0.307, rateDate: '2026-06-15' }
GET  → { data: [{ currency, rate, rateDate, createdAt }] }
```

Stored in a new `FxRateEntry` model. No DB migration complexity — purely additive.

---

## Admin UI Changes

### `finance/expenses/new/page.tsx`

- Currency selector (select, default KWD, shows ISO codes from `ALLOWED_CURRENCIES`).
- When currency ≠ KWD (and feature gate active): show `fxRate` input + live preview "= X.XXX KWD".
- `originalAmount` = the raw amount in foreign minor units (the amount input).
- KWD total preview updates live: `kwdFils = Math.round(amount × fxRate)`, displayed as `(kwdFils / 1000).toFixed(3) KWD`.
- On submit: include `currency`, `fxRate`, `originalAmount` in payload.

### `finance/journal/new/page.tsx`

- Per-line currency selector + fxRate (shown only when currency ≠ KWD and feature active).
- Live KWD equivalent shown.
- `debit`/`credit` fields now mean "KWD fils to post" — when non-KWD, auto-computed; user can override.

### `finance/expenses/page.tsx` (list view)

- Show `originalAmount + currency` column when multi_currency feature is active and any expense has a non-KWD currency.
- KWD column header changes to "Amount (KWD)" to disambiguate.

---

## Feature Gate Behaviour

- `requireFeature('accounting.multi_currency')` applied on:
  - The FX rate endpoint.
  - The `currency` + `fxRate` + `originalAmount` fields in the expense create route (silently stripped when absent — KWD passthrough).
  - The admin UI currency/fxRate inputs (hidden when feature absent).
- `accounting.basic` still gates all existing routes. `accounting.expenses` still gates expense routes.

---

## KWD-Unchanged Guarantee

1. **Schema**: new columns are optional with defaults (`fxRate DEFAULT 1`, `originalAmount DEFAULT 0`). No existing row is altered.
2. **Service**: `if (!currency || currency === 'KWD') { /* existing path, no new fields written */ }`.
3. **Test**: `multi-currency.test.ts` has a case `kwd_passthrough_is_bytewise_identical` that calls `createExpense` with KWD and asserts `fxRate === null || fxRate === 1` and `originalAmount === amount`.
4. **Reports**: `profitAndLoss`, `trialBalance`, `balanceSheet` all query `debit`/`credit` — unchanged KWD fils.

---

## Tests

`tests/unit/multi-currency.test.ts`:

- `convertToKwd — basic multiplication half-up rounding` (7 cases)
- `convertToKwd — zero originalAmount` → 0
- `convertToKwd — KWD passthrough (fxRate=1)` → amount unchanged
- `convertToKwd — large amounts no integer overflow risk` (BigInt-safe boundary)
- `fxRate validation — negative rate throws`
- `fxRate validation — zero rate throws`
- `KWD expense create does not set fxRate or originalAmount differently from before` (regression)
- `non-KWD expense posts KWD amount in debit/credit, preserves originalAmount`

---

## Doc Parity (same commit)

- `packages/shared/src/features.ts` — already has the key; description verified correct.
- `docs/business/02-feature-catalog.md` — add multi-currency row.
- `docs/business/plan-feature-matrix.md` — mark `accounting.multi_currency` = Enterprise.
- `ROADMAP.md` — mark multi-currency as done.

---

## Migration Name

`20260615000000_add_journal_line_fx_fields`

SQL:

```sql
ALTER TABLE journal_lines ADD COLUMN fx_rate DECIMAL(16,8) DEFAULT 1;
ALTER TABLE journal_lines ADD COLUMN original_amount INTEGER DEFAULT 0;
ALTER TABLE expenses ADD COLUMN fx_rate DECIMAL(16,8) DEFAULT 1;
ALTER TABLE expenses ADD COLUMN original_amount INTEGER DEFAULT 0;
```

No data backfill needed — defaults cover all existing rows.

---

## Money-path Risk Summary for Review

| Risk                                      | Mitigation                                                                              |
| ----------------------------------------- | --------------------------------------------------------------------------------------- |
| Float drift on FX multiply                | Prisma Decimal (exact) + `Math.round` only at final integer step                        |
| KWD rows broken                           | Optional columns + `DEFAULT 1`/`DEFAULT 0`; regression test                             |
| DR≠CR when converting                     | Caller computes KWD amount before passing to postEntry; postEntry still validates DR=CR |
| Double-posting with FX                    | postEntry idempotency (source, sourceId) is unchanged                                   |
| Non-KWD OCR expense wrong amount          | Stored as draft + note to set FX rate; `fxRate=1` placeholder until merchant reviews    |
| Reports include non-KWD in wrong currency | Reports only sum `debit`/`credit` (KWD fils) — untouched                                |
