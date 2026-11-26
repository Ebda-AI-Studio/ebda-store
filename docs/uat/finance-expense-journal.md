---
feature: finance-expense-journal
updated: 2026-06-09
fixes: C2 (expense date-422), H2 (paid-from guard), H1 (journal role), PR-#86/#87
---

# UAT: Finance — Expense Creation & Journal Entry

**Reviewer account:** store_admin (expenses, manual journal entries, reversals, period close, payouts)
**Pre-conditions:**

- Store has Chart of Accounts seeded (Admin → Finance → Accounts → "Seed COA" if empty)
- At least one cash/bank account exists (code 1000–1099: Cash Online, Cash Card, Cash COD, Bank Main)
- At least one expense account exists (5xxx or 6xxx codes)
- MFA enrolled on the reviewer accounts (finance routes require MFA)

---

## Golden path — Create Expense

1. Navigate to **Admin → Finance → Expenses → New Expense**
2. Fill in:
   - **Supplier:** (optional, leave blank)
   - **Expense Account:** select any expense account (e.g. "Office Supplies")
   - **Paid From:** select **Cash Online** (code 1000) — a valid cash/bank account
   - **Amount:** 5.00 EGP
   - **Date:** click the date picker and select today's date (browser emits `YYYY-MM-DD`)
3. Click **Save / Submit**
4. Verify: **201 Created** — expense appears in the list
5. Open the created expense → verify all fields (including date) display correctly

---

## Golden path — Journal Manual Entry (store_admin and super_admin)

1. Log in as **store_admin**
2. Navigate to **Admin → Finance → Journal → New Entry**
3. Add two balanced lines (total debit = total credit):
   - Line 1: Account = Cash Online, Debit = 100.00
   - Line 2: Account = Sales Revenue, Credit = 100.00
4. Add a memo: "Audit test entry"
5. Click **Post Entry**
6. Verify entry appears in the Journal list with the correct accounts and amounts

---

## Edge cases — Expense Date

- [ ] **Date from date picker (YYYY-MM-DD)** — the native date input emits `2026-06-15` not `2026-06-15T00:00:00.000Z`. Must NOT produce a 422 error.
- [ ] **Future date** — select a date 30 days ahead → should save (no future-date block on expenses)
- [ ] **Past date** — select a date from last year → should save
- [ ] **Date cleared** — if the date field is optional, clearing it → verify no crash

---

## Edge cases — Paid-From Guard

- [ ] **Select Accounts Receivable (1100) as Paid From** — if the dropdown allows it (pre-fix), verify the API now rejects it with `INVALID_PAID_FROM` and an error is shown
- [ ] **Select Inventory Account as Paid From** — same: must be rejected
- [ ] **Select Cash Online (1000)** — must be accepted (golden path above)
- [ ] **Select Bank Main (1030)** — must be accepted

---

## Edge cases — Journal Role Guard

- [ ] **store_admin visiting Journal → New Entry** — the "New Entry" button/form should NOT be visible (UI matches the API's super_admin-only rule). If the form IS shown and store_admin submits it, the API must return 403.
- [ ] **super_admin with imbalanced lines** — DR ≠ CR → entry must be rejected with a descriptive error (not 500)
- [ ] **super_admin with single line** — schema requires min 2 lines → 422

---

## Pass criteria

- [ ] Date picker value (`YYYY-MM-DD`) accepted by expense create → 201
- [ ] Non-cash paid-from account rejected with `INVALID_PAID_FROM` error message
- [ ] Cash/bank accounts (1000–1099) accepted as paid-from
- [ ] store_admin cannot post journal entries (either form hidden or API returns 403)
- [ ] super_admin can post balanced manual journal entries
- [ ] No 500s in any scenario above

---

## Accounting audit fixes (ACCT-AUDIT-1 to 11, 2026-11-14)

- [ ] **Partial PO receipt** — receive 4 of 10 units at 1.00 EGP, then the other 6 → Finance → Journal shows two PO receive entries (4.00 then 6.00); Inventory and Accounts Payable both read 10.00.
- [ ] **Receipt OCR VAT** — upload a 114.00 receipt with 14.00 VAT → the draft shows amount 100.00, tax 14.00, total 114.00 (not 128.00).
- [ ] **Expense VAT** — post that expense → the journal debits the expense 100.00 and **VAT Recoverable (1300)** 14.00, credits cash 114.00. A store whose chart has no 1300 yet (run **Seed COA**) keeps the old single debit.
- [ ] **Backdated expense** — post an expense dated last month → its journal entry carries last month's date.
- [ ] **Close the books** — Finance → Journal → "إقفال الدفاتر": pick the last day of last month → a manual entry dated inside it is refused with PERIOD_LOCKED; an automatic entry for an old document lands on the first open day; "افتح كل الشهور" reopens.
- [ ] **Reverse a manual entry** — open a manual entry → "اعكس القيد ده" → reason required → a mirror entry appears dated today, the original shows "Reversed by"; a second attempt, or a system entry, has no button / is refused.
- [ ] **Bank CSV** — a semicolon file with `100,50` imports 100.50; a header `التاريخ,الوصف,مدين,دائن`, a windows-1256 file and a file with a bank preamble all import.
- [ ] **Identical bank lines** — two identical same-day lines import as two rows and "imported" says 2; re-uploading the file imports 0 and reports them as already imported.
- [ ] **Payout** — Finance → Bank reconciliation → "سجّل تحويل مستحقات": gross 1000.00, fee 25.50 → bank +974.50, bank fees +25.50, cash-in-transit −1000.00.
