# ID-6

> Section: Lifecycle emails and referral attribution (2026-10-22, branch `feat/lifecycle-emails`)

Ruling ID-6 (2026-10-24) - the Store checks `Accounts.isRevoked(sid)` on every authenticated admin request, not only sensitive ones: logout is immediate, not 15 minutes later. Cost if wrong: one Service Binding sub-request per admin call; narrow to sensitive-only in one function if latency matters.
