# Auth / Access / Privacy Audit — 2026-05-28

**Scope:** Authentication events, session lifecycle, role mutations, credential rotations, webhook secrets, GDPR/Kuwait Law erasure, data export, tenant isolation, cookie consent, push subscriptions, PII access, bot mode.  
**Excludes:** Business state machines (payments, orders, returns, shipments, reviews, affiliates, loyalty) — those are covered in the companion `2026-05-28-mutate-in-place-audit.md`.  
**Method:** Grep coverage map of `auditLog({ action: '...' })` writes per surface, cross-referenced against the surfaces themselves.

---

## Executive Summary

The FWB codebase has solid audit coverage for the happy-path auth flows (login success/failure via both `auth.routes.ts` + `account-lockout.service.ts`, register, erase, export, user CRUD by super*admin). Five critical gaps remain. The most dangerous: (1) password change/reset are **never audit-logged** so an attacker who exploits a reset token leaves no trace in `AuditLog`; (2) role escalations record only `changedFields: "role"` with no before/after values, making reversal impossible without raw DB inspection; (3) refresh-token reuse detection (a session-hijack signal) is logged to `pino` only — never to `AuditLog`; (4) the `wbs_integration_updated` audit captures whether the WBS API key \_changed* but not whether the Meta access token changed, and neither event records the masked old value; (5) cookie consent mutations are browser-only (no server-side record), making compliance reconstruction for Kuwait Law 13/2023 unverifiable.

---

## P0 Gaps — Auth / Identity / Money-adjacent

### P0-A: Password change has no audit log

**File:** `apps/api/src/routes/auth.routes.ts` lines 429–457  
**File:** `apps/api/src/services/auth.service.ts` lines 650–675

`POST /auth/change-password` calls `AuthService.changePassword()` and returns success with zero `auditLog()` call in the route. The service revokes all refresh tokens and updates `passwordHash` in the DB but writes no audit row. An attacker who gained temporary DB write access, or a compromised admin who called `PUT /admin/users/:id` with a new password field (where the audit entry only records `changedFields: "password"` — no actor IP attribution beyond `req.ip` on the outer update), leaves no forensic timestamp that could be cross-referenced against a suspicious login.

**Gap:** `user.password_changed` is absent from `AuditLog`. No IP, no actor, no timestamp linkable to downstream session activity.

**Fix:** Add `auditLog({ action: 'user.password_changed', userId, ip, userAgent })` at the end of the `POST /auth/change-password` handler (auth.routes.ts line ~450). Mirror in `AuthService.changePassword()` for any internal callers.

---

### P0-B: Password reset (forgot-password + reset-password) has no audit log

**File:** `apps/api/src/routes/auth.routes.ts` lines 460–537

`POST /auth/forgot-password` (lines 460–491) silently returns success and calls `AuthService.requestPasswordReset()` with no audit row. `POST /auth/reset-password` (lines 493–537) calls `AuthService.resetPassword()`, which revokes all session tokens and rewrites `passwordHash`, also with no audit row.

**Gap:** A stolen reset token redeemed by an attacker is invisible in `AuditLog`. The only signal is in `RefreshToken.revokedReason = 'password_reset'` (DB column, not queryable via the admin audit-log UI at `GET /admin/audit-logs`).

**Fix:**

- `POST /auth/forgot-password`: `auditLog({ action: 'user.password_reset_requested', details: { email }, ip, userAgent })` — note: deliberately omit userId to preserve enumeration protection.
- `POST /auth/reset-password`: `auditLog({ action: 'user.password_reset_completed', resourceType: 'user', resourceId: storedToken.userId, ip, userAgent })` after `AuthService.resetPassword()` succeeds.

---

### P0-C: Role escalation loses before/after values

**File:** `apps/api/src/routes/admin.routes.ts` lines 486–580

When `PUT /admin/users/:id` updates a user's role, the audit entry is:

```ts
details: {
  changedFields: changed.join(', ');
} // line 568
```

`changed` is a list of field names (e.g. `"role, status"`) with no old or new values captured. The code reads `existing` before the update (line 503) but discards it after the update call (line 540). A forensic investigator cannot determine whether a user was escalated from `customer → super_admin` or demoted from `store_admin → customer` without querying raw DB history, which may have been wiped by the 90-day `AuditLog` archive job.

**Gap:** Role change direction is unrecoverable from audit logs. A rogue super_admin who escalated a compromised account and then downgraded it again would leave only `changedFields: "role"` twice.

**Fix:** Capture `fromRole: existing.role, toRole: data.role` in `details` when `data.role` is set. Same for `status`. Minimal additional PII risk since roles are not personal data.

---

### P0-D: Refresh-token reuse detection writes logger.warn only — not AuditLog

**File:** `apps/api/src/services/auth.service.ts` lines 483–497

When a revoked refresh token is replayed (the OWASP session-hijack signal), the code correctly revokes the entire token family but only writes to `pino`:

```ts
logger.warn({ userId, tokenId, revokedAt, revokedReason }, 'Refresh-token reuse detected ...');
```

No `auditLog()` call. pino logs are a 30-day rolling drain (per the Railway log-drain config). After 30 days, evidence of a session-hijack attempt disappears. The `AuditLog` table has a 90-day archive job (Inngest `audit-log-archive.ts`) providing a longer retention window.

**Gap:** `token.reuse_detected` is absent from `AuditLog`. The forensic trail for account-takeover attempts evaporates after 30 days.

**Fix:** Add immediately after line 495:

```ts
await auditLog({
  action: 'token.reuse_detected',
  userId: storedToken.userId,
  resourceType: 'session',
  resourceId: storedToken.id,
  details: { revokedReason: storedToken.revokedReason ?? null },
  ip: req?.ip, // will be undefined in service layer — pass through from caller
  userAgent: req?.headers['user-agent'],
});
```

Note: `AuthService.refreshTokens()` is called from the route layer — pass `req` as an optional context parameter or restructure the revocation into the route handler where IP is available.

---

### P0-E: Logout has no audit log

**File:** `apps/api/src/routes/auth.routes.ts` lines 276–295

`POST /auth/logout` calls `AuthService.logout(refreshToken)` which marks the token as `revokedReason: 'logout'` in the DB, but the route handler itself has no `auditLog()` call. Unlike login (which has two audit rows — success and failure), logout leaves no forensic timestamp.

**Gap:** No `user.logout` row. A stolen session that was actively used and then logged out (to cover tracks after extraction) has no end-of-session marker correlatable to the suspicious login entry.

**Fix:** Add `auditLog({ action: 'user.logout', userId: (decoded token).userId, ip, userAgent })` in the route handler. The refresh token can be decoded to extract `userId` without a DB lookup since the logout handler already accepts the raw JWT.

---

## P1 Gaps — Operational / Credential Lifecycle

### P1-A: Meta access token rotation not surfaced in audit detail

**File:** `apps/api/src/routes/wbs-integration.routes.ts` lines 416–419, 646–658

The `store.wbs_integration_updated` audit (line 646) records `{ wbsEnabled, wbsClientId, apiKeyChanged, keyCleared }` for the WBS API key rotation. But when `input.metaAccessToken` is set (line 416–419), the audit captures nothing about this — not even a boolean `metaTokenChanged: true`. The Meta access token is a payment-adjacent credential: it gates Facebook Catalog browsing and native checkout flows. A rotated-but-leaked token has no timestamp trail.

**Gap:** Meta access token rotation is silently omitted from `AuditLog`.

**Fix:** Add `metaTokenChanged: input.metaAccessToken !== undefined` to the audit `details` map on line 651. Optionally include the masked first-4/last-4 of the new token for correlation.

---

### P1-B: Super_admin reads of customer PII — not audit-logged

**File:** `apps/api/src/routes/admin.routes.ts` lines 902–948 (`GET /admin/customers`)

The `GET /admin/customers` endpoint returns full customer records (email, firstName, lastName, phone via the `Customer` model) to any `super_admin`. The `requireStoreAccess` middleware only audit-logs write methods (line 57: `const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(req.method)`). There is no `auditLog()` call in the customers list or individual customer GET handlers.

**Gap:** A super_admin exfiltrating the full customer list leaves no trace in `AuditLog`. Kuwait Law 13/2023 Art. 7 requires data controllers to log PII access for accountability.

**Fix:** Add `auditLog({ action: 'customer.pii_accessed', userId: req.user.userId, details: { query: JSON.stringify(req.query) }, ip, userAgent })` in the `GET /admin/customers` handler. For individual customer GETs, add `{ action: 'customer.pii_accessed', resourceId: customerId }`.

---

### P1-C: Bot mode mutation has Telegram alert but no AuditLog row

**File:** `apps/api/src/routes/wbs-integration.routes.ts` lines 471–491, 646–658

`botMode` transitions to `native_catalog` / `native_catalog_with_gemini_agent` fire a Telegram alert (line 481). However, the `store.wbs_integration_updated` audit entry (line 646) records `{ wbsEnabled, wbsClientId, apiKeyChanged, keyCleared }` — `botMode` is not included. A super_admin who flips bot mode back from native_catalog to legacy_chat (e.g. after a catalog issue) leaves no audit row; only the Telegram alert exists, which is not queryable via `GET /admin/audit-logs`.

**Gap:** `botMode` mutation is not in `AuditLog`. The alert-only path means compliance queries cannot reconstruct the mode change timeline.

**Fix:** Add `botModeChanged: input.botMode !== undefined, prevBotMode: prevStore?.botMode ?? null, newBotMode: input.botMode ?? null` to the audit `details` map.

---

### P1-D: OneSignal subscribe/unsubscribe not audit-logged

**File:** `apps/api/src/routes/onesignal.routes.ts` lines 70–87 (subscribe), 117–133 (delete device)  
**File:** `apps/api/src/routes/notification.routes.ts` lines 371–420 (storefront push subscribe/unsubscribe)

Admin OneSignal subscription (`POST /admin/notifications/onesignal/subscribe`) and device deletion (`DELETE /admin/notifications/onesignal/devices/:playerId`) have no `auditLog()` calls. Similarly, storefront `POST /public/:storeId/push/subscribe` and `POST /public/:storeId/push/unsubscribe` only write to `logger.info`.

**Gap:** Push subscription lifecycle is invisible in `AuditLog`. A push token endpoint compromise (where an attacker registers their device for admin order alerts) leaves no trace. The `eraseAccount` path correctly deletes push subscriptions but there's no record of when they were created.

**Fix:** For admin device registration/deletion, add `auditLog({ action: 'push.device_registered' | 'push.device_revoked', userId, resourceType: 'push_subscription', ip, userAgent })`. For storefront subscriptions, a simpler structured log (pino with `storeId` + `endpoint hash`) is acceptable given the anonymous nature, but an `AuditLog` row is better for erasure audits.

---

### P1-E: Cookie consent mutation — server has no record

**File:** `apps/web/src/contexts/ConsentContext.tsx` lines 87–102

Cookie consent is written purely client-side via `document.cookie` (line 60–62). The server reads it in `layout.tsx` line 365 to gate pixel scripts, but never writes any server-side record of the consent decision. The `ConsentState` has a `ts` ISO timestamp field (line 21), but this lives only in the browser cookie — it can be cleared, expired, or lost when a customer uses a new device or clears cookies.

**Gap:** Consent history is unrecoverable after cookie expiry (1-year max-age). Kuwait Law 13/2023 Art. 9 requires demonstrable consent — "we set a cookie" is insufficient if the cookie is gone.

**Fix (lightweight):** On first consent decision, POST to `POST /public/:storeId/consent` with `{ marketing: bool, ip, userAgent, ts }`. Write an `AuditLog` row: `{ action: 'customer.consent_granted' | 'customer.consent_rejected', resourceType: 'consent', details: { marketing, storeId } }`. Identified customers include `customerId`. This creates a verifiable server-side consent log that survives cookie clearing.

---

## P2 Gaps — Internal Admin Convenience

### P2-A: Account lockout events not surfaced in the admin audit-log UI

**File:** `apps/api/src/services/account-lockout.service.ts` lines 197–211

Account lockout _does_ write to `prisma.auditLog` (line 199–205) with `action: 'LOGIN_SUCCESS' | 'LOGIN_FAILED'`. However, the action strings use `SCREAMING_SNAKE_CASE` (`LOGIN_FAILED`) while all other audit actions use `dot.notation` (`user.login.failed`). The admin UI at `GET /admin/audit-logs` filters by `action` prefix — a query for `action.contains: "user.login"` will miss `LOGIN_FAILED` entries from the lockout service while matching `user.login.failed` entries from `auth.routes.ts`.

**Gap:** Login failure data is split across two naming schemes, making timeline reconstruction require two separate queries. This is a data quality defect in existing coverage.

**Fix:** Normalize `account-lockout.service.ts` to emit `action: 'user.login.failed'` and `action: 'user.login.success'` to match the convention in `auth.routes.ts`. The lockout service entries will then merge cleanly into the auth event timeline.

---

### P2-B: Session refresh (token rotation) has no audit row

**File:** `apps/api/src/services/auth.service.ts` lines 464–543 (`refreshTokens`)

Normal token rotation (a refresh token consumed and replaced) is not audit-logged. Each rotation rewrites the `RefreshToken` row chain (`replacedById` back-link exists) but no `AuditLog` row is written. Forensically, knowing that a long-lived session was kept alive via rotation is useful (especially when paired with a suspicious IP change between rotations).

**Gap:** No `session.token_rotated` event. An attacker who held a stolen refresh token for weeks would show no activity in `AuditLog` between their initial theft and eventual detection.

**Fix (low-priority):** Add `auditLog({ action: 'session.token_rotated', userId, details: { oldTokenId: storedToken.id, newTokenId: newRow?.id } })`. Accept that this generates high volume (one row per active session per 30-day JWT lifetime) and consider a flag to disable in dev.

---

### P2-C: Data export by a super_admin on behalf of a user — not distinguished

**File:** `apps/api/src/routes/auth.routes.ts` lines 382–406 (`GET /auth/me/export`)

The existing `user.data_exported` audit row records `userId` (the account being exported) as both the actor and the resource. When a super_admin manually triggers an export for a customer (e.g. to respond to a GDPR SAR), the audit row is identical to the customer self-exporting. There is no `actorId` separate from `userId`.

**Gap:** Unable to distinguish self-export (GDPR right to portability) from admin-export (internal access to PII). This affects GDPR Art. 15 accountability records.

**Fix:** The `AuditLog` schema already has a `userId` column (the actor). Change the route to write `userId: req.user!.userId` (actor) and `resourceId: targetUserId` (the exported account). Today, both are the same user since this is a self-service route — but this sets up correct semantics for a future admin-on-behalf path.

---

## Prioritized Close-Out Plan

| Priority | Gap                                                  | Effort                                                     | Compliance Exposure                            |
| -------- | ---------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------- |
| 1        | **P0-A** — password change no audit                  | 10 min — one `auditLog()` call in route                    | GDPR Art. 32 / Kuwait Law Art. 12              |
| 2        | **P0-B** — password reset no audit                   | 20 min — two `auditLog()` calls in routes                  | Same as above                                  |
| 3        | **P0-E** — logout no audit                           | 10 min — one `auditLog()` call                             | Forensic session closure                       |
| 4        | **P0-C** — role change no before/after               | 15 min — read `existing.role` into `details`               | Insider threat reversal                        |
| 5        | **P0-D** — token reuse detection not in AuditLog     | 30 min — propagate IP context to service, add `auditLog()` | Session-hijack forensics                       |
| 6        | **P2-A** — lockout naming mismatch                   | 20 min — normalize to `user.login.failed`                  | Data quality / query correctness               |
| 7        | **P1-A** — Meta token rotation not in audit detail   | 10 min — add `metaTokenChanged` to existing audit          | Credential forensics                           |
| 8        | **P1-C** — botMode not in audit detail               | 10 min — add `botMode` fields to existing audit            | Compliance / ops reconstruction                |
| 9        | **P1-B** — super_admin PII reads not logged          | 30 min — add `auditLog()` to customer list/get handlers    | Kuwait Law 13/2023 Art. 7                      |
| 10       | **P1-D** — push subscription lifecycle not logged    | 45 min — add audit rows to onesignal + notification routes | Erasure audit completeness                     |
| 11       | **P1-E** — cookie consent server-side record missing | 2h — new `/public/:storeId/consent` endpoint + schema      | Kuwait Law 13/2023 Art. 9 demonstrable consent |
| 12       | **P2-B** — token rotation not logged                 | 1h — high volume, evaluate flag                            | Nice-to-have forensics                         |

### Notes

- Items 1–6 are mechanical one-liner changes. Ship together in a single commit.
- Items 7–10 are additive detail to existing audit calls — batch in the same PR.
- Item 11 (cookie consent server record) requires a new DB column (`CustomerConsent` or an `AuditLog` write pattern) and a new public route — ship as a standalone PR.
- Item 12 (token rotation) generates high volume; add a `AUDIT_TOKEN_ROTATION=true` env flag so production can opt in selectively.

### Auth coverage map — current state

| Surface                                       | Covered                                                                  | Missing                                          |
| --------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------ |
| Register                                      | `user.register`                                                          | —                                                |
| Login success                                 | `user.login` (route) + `LOGIN_SUCCESS` (lockout)                         | Naming inconsistency (P2-A)                      |
| Login failure                                 | `user.login.failed` (route) + `LOGIN_FAILED` (lockout)                   | Same                                             |
| Account lockout trigger                       | written by lockout service                                               | Not surfaced as separate `account.locked` action |
| Logout                                        | none                                                                     | P0-E                                             |
| Token refresh (rotation)                      | none                                                                     | P2-B                                             |
| Token reuse detection                         | `logger.warn` only                                                       | P0-D                                             |
| Password change                               | none                                                                     | P0-A                                             |
| Password reset request                        | none                                                                     | P0-B                                             |
| Password reset completed                      | none                                                                     | P0-B                                             |
| Account soft-delete                           | `user.account.deleted`                                                   | —                                                |
| Account erase (GDPR)                          | `user.account.erased`                                                    | —                                                |
| Account export (self)                         | `user.data.exported`                                                     | Actor=Resource ambiguity (P2-C)                  |
| Email verified                                | `user.email.verified`                                                    | —                                                |
| Role change                                   | `user.updated` (changedFields)                                           | No before/after (P0-C)                           |
| Admin password reset                          | `user.updated` (changedFields: password)                                 | No separate event                                |
| Store access by super_admin (writes)          | `STORE_ACCESS`                                                           | Read access not logged (P1-B)                    |
| WBS API key rotation                          | `store.wbs_integration_updated` (apiKeyChanged)                          | —                                                |
| Meta access token rotation                    | covered by `store.wbs_integration_updated` but no detail flag            | P1-A                                             |
| Bot mode mutation                             | Telegram alert only                                                      | P1-C                                             |
| Payment webhook secret rotation               | `payment_config.updated` (provider only, no `webhookSecretChanged` flag) | Minor detail gap                                 |
| OneSignal subscribe/unsubscribe               | none                                                                     | P1-D                                             |
| Storefront push subscribe/unsubscribe         | none                                                                     | P1-D                                             |
| Cookie consent decision                       | browser cookie only                                                      | P1-E                                             |
| GDPR erasure by retention cron                | `user.account.anonymized_by_retention_cron`                              | —                                                |
| Customer PII bulk read (GET /admin/customers) | none                                                                     | P1-B                                             |
