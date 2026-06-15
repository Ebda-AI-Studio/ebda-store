# UAT — Tax Reports (accounting.tax_reports)

**Feature gate:** Enterprise plan (`accounting.tax_reports`)  
**Location:** Admin → Finance → Reports → Tax Report tab

---

## Prerequisites

- Store has `accounting.tax_reports` feature enabled
- Store has `accountingEnabled = true`
- COA seeded (account 2100 "Tax Payable" must exist)
- At least one paid order with `tax > 0` in the test period
- At least one paid order with `tax = 0` (to verify exclusion)

---

## Golden path

### 1. Navigate to the Tax Report tab

1. Sign in as store admin → Stores → [Store] → Finance → Reports
2. Click the **Tax Report** tab
3. **Expect:** Date range pickers (From / To) defaulting to current-month start and today; a loading spinner; then either a results table or "No taxable transactions" empty state

### 2. Verify summary cards

1. Set **From** = first day of a month that has paid taxable orders, **To** = last day of that month
2. Click away (the fetch auto-triggers on field change)
3. **Expect:**
   - **Total Transactions** card shows the count of orders with tax > 0 in that period
   - **Total Taxable Sales** card shows the sum of (subtotal - discount) in KWD (3 decimal places)
   - **Total Tax Collected** card (amber) shows the sum of tax collected in KWD

### 3. Verify by-rate breakdown table

1. With the same date range
2. **Expect:** A "Breakdown by Rate" section appears if tax rates differ
   - One row per distinct effective tax rate (e.g. 5.00%, 10.00%)
   - Columns: Tax Rate, Transactions, Taxable Base (KWD), Tax Collected (KWD)
   - Totals across all rates match the summary cards

### 4. Verify transaction table

1. **Expect:** One row per taxable order, ordered by date ascending
   - Date | Order # | Customer | Taxable Base (KWD) | Tax Rate | Tax Collected (KWD) | Order Total (KWD)
   - Guest orders show "Guest" in the Customer column
   - Footer row shows column totals for Taxable Base and Tax Collected
   - Order C (tax = 0) does NOT appear in the list

### 5. Export CSV

1. Click **Export CSV** (enabled only when rows > 0)
2. **Expect:**
   - Browser downloads `tax-report-YYYY-MM-DD-to-YYYY-MM-DD.csv`
   - File has a header row and one data row per transaction
   - KWD amounts have 3 decimal places

### 6. Export XLSX

1. Click **Export XLSX**
2. **Expect:**
   - Browser downloads `tax-report-YYYY-MM-DD-to-YYYY-MM-DD.xlsx`
   - Sheet "Tax Report" has: bold grey header row, transaction rows, then a summary section below
   - KWD columns formatted as `#,##0.000`
   - Amount columns are numeric (not text) so Excel can SUM them

---

## Edge cases

### E1 — Period with no taxable transactions

1. Set **From** / **To** to a past period that has no paid orders (or only tax=0 orders)
2. **Expect:** "No taxable transactions in this period." message; Export buttons disabled

### E2 — Multiple tax rates in one period

1. Ensure some orders were charged at 5% VAT and others at 10% (or any two distinct rates)
2. **Expect:** By-rate table shows two rows; each row's count + totals are correct; combined totals match summary cards

### E3 — Date boundary (first and last day of month inclusive)

1. Set **From** = 2026-01-01, **To** = 2026-01-31
2. **Expect:** Orders paid on 2026-01-01 AND 2026-01-31 both appear; orders from 2026-01-15 appear; orders before 2026-01-01 or after 2026-01-31 do not appear

### E4 — Guest orders

1. Place a paid taxable order without a logged-in customer (guest checkout)
2. **Expect:** Row appears with Customer = "Guest"

### E5 — Feature gate enforcement

1. Disable `accounting.tax_reports` for the store (via Features admin or by plan tier)
2. Call `GET /api/v1/stores/:storeId/finance/reports/tax-report?from=…&to=…`
3. **Expect:** `403 FEATURE_NOT_ENABLED` response
4. Also verify the Tax Report tab is not accessible (if the admin surfaces it conditionally)

### E6 — Orders with discount

1. Place a paid taxable order with `discount > 0` (e.g. subtotal=20 KWD, discount=5 KWD, tax = 5% of 15 KWD = 750 fils)
2. **Expect:** The Taxable Base column shows `15.000 KWD` (not 20.000), and Tax Collected = `0.750 KWD`

### E7 — Tenant isolation

1. The report only shows orders for the current store; orders for other stores never appear, even if they share the same user account

---

## JSON API contract

```
GET /api/v1/stores/:storeId/finance/reports/tax-report?from=YYYY-MM-DD&to=YYYY-MM-DD
Authorization: store_admin or super_admin
Feature: accounting.tax_reports (Enterprise)

200 response shape:
{
  "data": {
    "from": "2026-03-01T00:00:00.000Z",
    "to": "2026-03-31T23:59:59.999Z",
    "rows": [
      {
        "date": "2026-03-15",
        "orderNumber": "ORD-1001",
        "customerName": "Ahmad Sharaf",
        "subtotal": 10000,          ← fils integer (taxable base = subtotal - discount)
        "taxRate": "5.00",          ← string, e.g. "5.00" or "10.00"
        "taxCollected": 500,        ← fils integer
        "total": 10500              ← fils integer
      }
    ],
    "summary": {
      "transactionCount": 1,
      "totalTaxableSales": 10000,   ← fils
      "totalTaxCollected": 500,     ← fils
      "byRate": [
        {
          "taxRate": "5.00",
          "transactionCount": 1,
          "totalSubtotal": 10000,   ← fils
          "totalTaxCollected": 500  ← fils
        }
      ]
    }
  }
}
```

```
GET /api/v1/stores/:storeId/finance/reports/tax-report.xlsx?from=YYYY-MM-DD&to=YYYY-MM-DD
→ 200 application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
```

---

## Data source verification

The report sources data from:

- `journal_lines` WHERE `accounts.code = '2100'` (Tax Payable) AND `credit > 0`
- Joined to `journal_entries` (status = 'posted', source = 'order', postedAt in [from, to])
- Joined to `orders` via `journal_entry.source_id = orders.id`
- Left-joined to `customers` for display name

Tax is confirmed to post to account 2100 in `apps/api/src/services/accounting/posting/order-posting.ts` via `postOrderPaymentJournal`. Effective tax rate is **derived** from (tax_collected / taxable_base × 100) rather than stored on the order, because the rate is not persisted on the order record.
