# UAT Checklist — Two-Factor Authentication (MFA)

Tester: Ahmad Sharaf  
Feature branch: `feat/mfa-and-token-revocation`  
Related plan: `docs/superpowers/plans/2026-06-08-mfa-and-token-revocation.md`

---

## Golden path — enroll, login, backup code, disable

### 1. Enroll a new authenticator

- [ ] Log in as a `super_admin` user (no MFA yet).
- [ ] Navigate to **Account → Security**.
- [ ] Confirm a banner is visible: "Two-factor auth not enabled. Super-admins must enroll."
- [ ] Click **Enable 2FA**.
- [ ] Confirm a QR code is displayed alongside the manual entry key (base32 secret).
- [ ] Scan the QR code in an authenticator app (e.g. Google Authenticator, Authy).
- [ ] Enter the 6-digit TOTP code shown by the app.
- [ ] Confirm the API responds with 10 backup codes.
- [ ] Copy and store the backup codes somewhere safe (password manager / paper).
- [ ] Confirm the Security page now shows "2FA is enabled".

### 2. Login with TOTP code

- [ ] Log out.
- [ ] Log back in with email + password.
- [ ] Confirm you are NOT immediately logged in — a TOTP challenge screen appears.
- [ ] Enter the current 6-digit code from the authenticator app.
- [ ] Confirm successful login and redirect to the dashboard.

### 3. Login with a backup code

- [ ] Log out.
- [ ] Log back in with email + password.
- [ ] At the TOTP challenge, click **"Use a backup code"**.
- [ ] Enter one of the 10 backup codes received at enrollment.
- [ ] Confirm successful login.
- [ ] Log out and attempt to reuse the same backup code.
- [ ] Confirm login fails with an invalid-code error (code is consumed one-time only).

### 4. Disable MFA

- [ ] While logged in (with MFA active), navigate to **Account → Security**.
- [ ] Click **Disable 2FA**.
- [ ] Enter the current 6-digit TOTP code when prompted.
- [ ] Confirm the API responds with success and the page shows "2FA is not enabled".
- [ ] Log out, then log back in — confirm no TOTP challenge appears.

---

## Edge cases

### 5. Wrong code triggers rate limit

- [ ] Log in with email + password (MFA enrolled user).
- [ ] At the TOTP challenge, enter an incorrect 6-digit code 5 times in a row.
- [ ] Confirm a `429 Too Many Requests` response is returned after the limit.
- [ ] Wait for the rate-limit window to reset (15 min) or use a different IP.

### 6. Expired challenge token

- [ ] Log in with email + password, receive the `challengeToken` in the response.
- [ ] Wait more than 5 minutes without submitting it.
- [ ] Attempt to `POST /auth/mfa/verify` with the expired token.
- [ ] Confirm a `401` error with `MFA_CHALLENGE_INVALID`.

### 7. Challenge token cannot be used as an access token

- [ ] Obtain a raw `challengeToken` from a login response (MFA not yet verified).
- [ ] Use the token as a `Bearer` header on `GET /auth/me` or any protected route.
- [ ] Confirm a `401` error — the challenge token's `purpose: 'mfa'` flag is detected and rejected.

### 8. Re-enroll while MFA is already enabled

- [ ] Log in (MFA active).
- [ ] `POST /auth/mfa/enroll/begin` without disabling first.
- [ ] Confirm the API generates a new pending secret (stored but not yet enabled).
- [ ] Complete enrollment with a fresh code.
- [ ] Confirm the old secret no longer works and only the new authenticator does.

### 9. Lost authenticator — recovery via reset CLI

- [ ] Simulate a locked-out admin by deleting their TOTP app entry.
- [ ] Confirm login fails at the TOTP challenge (no valid code available).
- [ ] Run the recovery script against the local DB:
  ```bash
  npx tsx scripts/mfa-reset.ts <email>
  ```
- [ ] Confirm output: `MFA reset for <email>: 1 row(s)`.
- [ ] Log in again with email + password — confirm no TOTP challenge.
- [ ] Confirm any tokens issued before the reset are now rejected (tokenVersion bumped).
  - To verify: take a copy of an access token issued before the reset, use it on `/auth/me` after the reset → expect `401 TOKEN_REVOKED`.

### 10. Redis-down fail-open behavior (revocation bypassed during outage)

- [ ] (Staging only — do not run in prod) Stop the Redis service.
- [ ] Issue a `POST /auth/logout` — confirm it returns 200 (does not fail).
- [ ] Use the same token on `/auth/me` — confirm it returns **200** (fail-open: the jti denylist cannot be checked, so the token is accepted).
- [ ] Restart Redis.
- [ ] Use the same token — confirm it now returns **401 TOKEN_REVOKED** once Redis is back.
- [ ] Document: this is expected behavior. The tradeoff is documented in `docs/runbooks/mfa-recovery.md` and `DEPLOYMENT.md`.

### 11. super_admin enforcement: 403 before enrollment

- [ ] Create a new `super_admin` user account (no MFA enrolled).
- [ ] Log in (no TOTP challenge yet — MFA not set up).
- [ ] Attempt to access a protected admin resource (e.g. `GET /admin/stores`).
- [ ] Confirm a `403 MFA_SETUP_REQUIRED` response.
- [ ] Enroll MFA via `POST /auth/mfa/enroll/begin` + `POST /auth/mfa/enroll/verify`.
- [ ] Retry the protected resource — confirm `200`.

---

## Sign-off

| Check                                    | Pass / Fail | Notes |
| ---------------------------------------- | ----------- | ----- |
| Golden path enroll                       |             |       |
| Golden path login (TOTP)                 |             |       |
| Golden path backup code                  |             |       |
| Golden path disable                      |             |       |
| Wrong code rate limit                    |             |       |
| Expired challenge token                  |             |       |
| Challenge token rejected as access token |             |       |
| Re-enroll while enabled                  |             |       |
| Lost authenticator recovery CLI          |             |       |
| Redis-down fail-open                     |             |       |
| super_admin enforcement 403              |             |       |
