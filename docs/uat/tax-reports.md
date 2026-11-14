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
   - **Orders** card shows the number of distinct orders with a tax movement in that period, with the number of tax entries (each sale, and each refund or return that reversed tax) underneath
   - **Total Taxable Sales** card shows the sum of (subtotal - discount) in EGP (2 decimal places)
   - **Total Tax Collected** card (amber) shows the sum of tax collected in EGP

### 3. Verify by-rate breakdown table

1. With the same date range
2. **Expect:** A "Breakdown by Rate" section appears if tax rates differ
   - One row per distinct effective tax rate (e.g. 14.00%, 0.00%)
   - Columns: Tax Rate, Entries, Taxable Base (EGP), Tax Collected (EGP)
   - Totals across all rates match the summary cards

### 4. Verify transaction table

1. **Expect:** One row per tax-moving journal entry, ordered by date ascending: the sale, plus one row per refund or return that reversed tax (negative amounts)
   - Type | Date | Order # | Customer | Taxable Base (EGP) | Tax Rate | Tax Collected (EGP) | Order Total (EGP)
   - Type is **Sale** on the sale row and **Refund / return** on the rows that reverse it; one order can show several rows with the same Order #; refund/return rows are muted
   - Order Total is filled on the Sale row only (— on refund/return rows), so the column sums to each order's value once (#1253, #1208)
   - Guest orders show "Guest" in the Customer column
   - Footer row shows column totals for Taxable Base and Tax Collected
   - Order C (tax = 0) does NOT appear in the list

### 5. Export CSV

1. Click **Export CSV** (enabled only when rows > 0)
2. **Expect:**
   - Browser downloads `tax-report-YYYY-MM-DD-to-YYYY-MM-DD.csv`
   - File has a header row and one data row per entry, with Type as the first column
   - EGP amounts have 2 decimal places

### 6. Export XLSX

1. Click **Export XLSX**
2. **Expect:**
   - Browser downloads `tax-report-YYYY-MM-DD-to-YYYY-MM-DD.xlsx`
   - Sheet "Tax Report" has: bold grey header row, entry rows (Type = Sale or Refund / return, Order Total empty on refund/return rows), then a summary section below
   - EGP columns formatted as `#,##0.00`
   - Amount columns are numeric (not text) so Excel can SUM them

---

## Edge cases

### E1 — Period with no taxable transactions

1. Set **From** / **To** to a past period that has no paid orders (or only tax=0 orders)
2. **Expect:** "No taxable transactions in this period." message; Export buttons disabled

### E2 — Multiple tax rates in one period

1. Ensure some orders were charged at 14% VAT and others at 0% (or any two distinct rates)
2. **Expect:** By-rate table shows two rows; each row's count + totals are correct; combined totals match summary cards

### E3 — Date boundary (first and last day of month inclusive, in the store's time zone)

Days are calendar days in the **store's time zone** (`stores.timezone`, Africa/Cairo for every
store today; a store with no usable zone falls back to Africa/Cairo — Rulings FRT-1/FRT-2 in
`docs/RULINGS.md`). The page shows the zone under the tabs.
The zone is set on the Tax page (card "Store time zone"). It is the store's ONE zone, so it also moves
checkout delivery-window cutoffs and the dates customers see; changing it writes a
`STORE_TIMEZONE_CHANGED` audit row with the old and new zone.

1. Set **From** = 2026-01-01, **To** = 2026-01-31
2. **Expect:** Orders paid on 2026-01-01 AND 2026-01-31 (Cairo time) both appear; orders from 2026-01-15 appear; orders before 2026-01-01 or after 2026-01-31 do not appear
3. **Expect:** An order paid at 01:30 Cairo time on 2026-02-01 (23:30 UTC on 2026-01-31) is NOT in January — it is in February, and its row is dated 2026-02-01

### E4 — Guest orders

1. Place a paid taxable order without a logged-in customer (guest checkout)
2. **Expect:** Row appears with Customer = "Guest"

### E5 — Feature gate enforcement

1. Disable `accounting.tax_reports` for the store (via Features admin or by plan tier)
2. Call `GET /api/v1/stores/:storeId/finance/reports/tax-report?from=…&to=…`
3. **Expect:** `403 FEATURE_NOT_ENABLED` response
4. Also verify the Tax Report tab is not accessible (if the admin surfaces it conditionally)

### E6 — Orders with discount

1. Place a paid taxable order with `discount > 0` (e.g. subtotal=20 EGP, discount=5 EGP, VAT 14% of 15 EGP = 2.10 EGP = 210 piastres)
2. **Expect:** The Taxable Base column shows `15.00 EGP` (not 20.00), and Tax Collected = `2.10 EGP`
3. **Expect:** the Tax Rate column reads `14.00%`, and a single-rate store with discounted and
   undiscounted orders shows ONE row in Breakdown by Rate. Checkout levies VAT after discount
   (`computeOrderTax`, `apps/api/src/lib/order-tax.ts`; owner decision on #193), so the report's
   `subtotal − discount` base is the base the tax was actually charged on. Orders placed before
   that change were taxed on the full subtotal and will still show an inflated derived rate.

> **Open (#193, needs owner):** checkout currently levies tax on the PRE-discount
> subtotal (`order.service.ts`: `Math.round(subtotal * taxRate)`), so this order
> is charged 2.80 EGP, not 2.10, and the report shows an 18.67% effective rate
> on a 15.00 base. Whether tax belongs on the discounted or the gross amount
> has not been decided; until it is, this case does not pass as written.

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
    "from": "2026-02-28T22:00:00.000Z",   ← 2026-03-01 00:00 in the store's zone (Africa/Cairo, UTC+2 in winter)
    "to": "2026-03-31T21:59:59.999Z",     ← 2026-03-31 23:59:59.999 in the store's zone
    "rows": [
      {
        "kind": "sale",             ← "sale" | "reversal" (a refund/return entry)
        "date": "2026-03-15",       ← posting day in the store's time zone
        "orderNumber": "ORD-1001",
        "customerName": "Ahmad Sharaf",
        "subtotal": 10000,          ← piastres integer (taxable base = subtotal - discount)
        "taxRate": "14.00",         ← string, e.g. "14.00" or "0.00"
        "taxCollected": 1400,       ← piastres integer
        "total": 11400             ← piastres integer on the sale row; null on a reversal row
      }
    ],
    "summary": {
      "transactionCount": 1,        ← journal entries (sales + reversals), not orders
      "orderCount": 1,              ← distinct orders
      "totalTaxableSales": 10000,   ← piastres
      "totalTaxCollected": 1400,   ← piastres
      "byRate": [
        {
          "taxRate": "14.00",
          "transactionCount": 1,
          "totalSubtotal": 10000,   ← piastres
          "totalTaxCollected": 1400  ← piastres
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

## Input VAT and net payable (ACCT-AUDIT-10)

- [ ] Post an expense with 14.00 VAT (chart seeded with **VAT Recoverable 1300**) → the report shows **Input VAT** 14.00 and **Net VAT to pay** = output − input; the XLSX export has both as Summary rows.
- [ ] A 33.33 sale at 14% (tax 4.67) lands in the **14.00** rate bucket, never a separate 14.01 / 13.99 one.
- [ ] A basket with a 14% item and an exempt item still shows its blended rate (the order lines carry no per-line rate; see Ruling ACCT-AUDIT-10).
