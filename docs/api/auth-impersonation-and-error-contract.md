# Auth, impersonation, error bodies and Server-Timing (API contract)

Admin fix pass 2026-11-04, track T1. Rulings: FP-1, FP-3, FP-4, LAZY-TX-3.

## Impersonation

`POST /admin/impersonate` (super_admin) mints a 1 h token with the target's real role and an `impersonatedBy` claim.

- A route that moves money, credentials, the live domain or staff access answers **403 `IMPERSONATION_FORBIDDEN`** to such a token (`rejectImpersonated`). The list: merchant MCP key mint, `POST /payments/refund`, `POST /payments/retry/:paymentId`, every `/payment-settings/store/:storeId[/...]` write (create, update, delete, toggle, credentials, test), `PUT /stores/:id/domain`, `POST /stores/:id/staff`, plus the account-level routes that already had it (password, email, MFA, passkeys, account delete, ...).
- Every audit row written during an impersonated request carries `details.impersonatedBy = <acting super_admin id>`. Callers do not pass it: `authenticate` enters an AsyncLocalStorage scope (`lib/impersonation-context.ts`) and `auditLog` reads it. A caller that already sets `details.impersonatedBy` keeps its value.

## Error body

Every error is `{ success: false, error: { code, message, details? } }`; `error.code` is always present and is what clients branch on.

`details.messageAr` + `details.messageEn` (Egyptian Arabic, Western digits; the admin shows `messageAr` in the Arabic locale and falls back to its own code -> Arabic map when absent) are guaranteed for:

| code                                                    | where                                                                                               |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `RATE_LIMITED`                                          | every limiter (the `res.json` hook in `lib/localized-error.ts`; the English `message` is unchanged) |
| `VALIDATION_ERROR`                                      | Zod failures; the per-field map (`details.<path>: string[]`) stays next to the two sentences        |
| plan gate (`FEATURE_NOT_AVAILABLE` and the limit codes) | `middleware/feature-gate.ts`                                                                        |
| `FILE_TOO_LARGE`, `LIMIT_*`                             | Multer upload errors (a fixed sentence; Multer's own text is no longer echoed)                      |

## Server-Timing

Every response carries `Server-Timing` with, in order: `request-tx` (commit/rollback of the request transaction, when one was open), then `auth` (signature check + live identity), `identity` (the identity RPC pair alone, 0 when answered from memo), `db-wait` (lease a pooled client + BEGIN + SET LOCAL), `handler` (the remainder of the wall time). Durations are milliseconds.

## Identity checks

Merchant / staff / admin tokens are checked live (revocation + account state) on every request except the allowlisted plain GETs (`lib/auth-sensitivity.ts`). Each RPC has a **3 s** budget (503 `IDENTITY_UNAVAILABLE`, never an allow). Account state is cached 30 s per account when positive and dropped by `setAccountStatus` / `setAccountRole` / `revokeIdentityUser`; revocation is never cached. Residual across isolates: 30 s (Ruling FP-4).

## Settings writes

`PUT /stores/:id` merges `settings` shallowly against the row as it is at write time, keeping only the keys the client sent. `mcpWriteEnabled` and `goldAllowDeferredPayment` are server-owned: a generic write drops them silently (their dedicated routes own them); `ebdaWhatsApp` still answers 400. `PUT /stores/:id/branding-bundle` takes `{ branding?, theme?, contact?, social?, settings?, blogEnabled? }` (strict) and applies the parts in one request transaction: any failure rolls back all of it.
