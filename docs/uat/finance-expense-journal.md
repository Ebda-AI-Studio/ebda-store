---
feature: finance-expense-journal
updated: 2026-06-09
fixes: C2 (expense date-422), H2 (paid-from guard), H1 (journal role), PR-#86/#87
---

# UAT: Finance — Expense Creation & Journal Entry

**Reviewer account:** store_admin (for expenses); super_admin (for journal entries)
**Pre-conditions:**

- Store has Chart of Accounts seeded (Admin → Finance → Accounts → "Seed COA" if empty)
- At least one cash/bank account exists (code 1000–1099: Cash KNET, Cash Card, Bank Main)
- At least one expense account exists (5xxx or 6xxx codes)
- MFA enrolled on the reviewer accounts (finance routes require MFA)

---

## Golden path — Create Expense

1. Navigate to **Admin → Finance → Expenses → New Expense**
2. Fill in:
   - **Supplier:** (optional, leave blank)
   - **Expense Account:** select any expense account (e.g. "Office Supplies")
   - **Paid From:** select **Cash KNET** (code 1000) — a valid cash/bank account
   - **Amount:** 5.000 KWD
   - **Date:** click the date picker and select today's date (browser emits `YYYY-MM-DD`)
3. Click **Save / Submit**
4. Verify: **201 Created** — expense appears in the list
5. Open the created expense → verify all fields (including date) display correctly

---

## Golden path — Journal Manual Entry (super_admin only)

1. Log in as **super_admin** (not store_admin)
2. Navigate to **Admin → Finance → Journal → New Entry**
3. Add two balanced lines (total debit = total credit):
   - Line 1: Account = Cash KNET, Debit = 100.000
   - Line 2: Account = Sales Revenue, Credit = 100.000
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
- [ ] **Select Cash KNET (1000)** — must be accepted (golden path above)
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
