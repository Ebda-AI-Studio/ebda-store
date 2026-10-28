# EBDA-MONEYA-8

> Section: 2026-10-08 — Money batch A: InstaPay proof, subscription billing fixes (branch `fix/money-a`, EBDA-MONEYA-\*)

Ruling EBDA-MONEYA-8 — Paying for a store beyond the store allowance (audit M4, CONFIRMED in `enforceStoreAllowance`): refused 409 `PAY_ON_PARENT_STORE` with `parentStoreId` (choose InstaPay, plan, receipt upload/submit, and the super-admin record), and the billing page shows `payOnStore` and links to the main store. Restoring is done by paying the main store (allowance follows the oldest store; existing restore path). Cost if wrong: a merchant who WANTS the child to be billed separately cannot until the parent's plan allows it.
