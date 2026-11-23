# MFA Recovery Runbook

Use this when an admin loses access to their authenticator app and cannot log in.

---

## Option 1 — Use a backup code (preferred)

At enrollment every admin receives 10 one-time backup codes. If the user saved them:

1. Go to the login page and enter email + password as usual.
2. When the TOTP challenge appears, click **"Use a backup code"**.
3. Enter any unused backup code (10-character hex string, e.g. `a3f9b2c1d0`).
4. The code is consumed immediately — it cannot be reused.
5. Once in, go to **Account → Security** and re-enroll a new authenticator or save the remaining codes.

### Making a new set (self-service, no staff)

While signed in (or right after using a code to get in), the admin opens **Account → Security → Recovery codes**, enters their password and a CURRENT authenticator code, and presses **Make new recovery codes** (`POST /mfa/recovery-codes/regenerate` on the identity service, `apps/accounts`). The old set dies in the same statement; the new 10 codes are shown once and stored only as bcrypt hashes. A recovery code is refused as the step-up, so someone holding only a code cannot mint more. `GET /mfa/recovery-codes` returns only the count left. Each regeneration logs `mfa_recovery_codes_regenerated` (user id only) in the Worker log.

If all backup codes are exhausted AND the authenticator is lost, the user cannot regenerate: proceed to Option 2 or 3 (staff, after verifying identity).

---

## Option 2 — Another super-admin disables MFA

A second super-admin (who has their own MFA working) can disable MFA on the locked-out account via the API:

```bash
# Step 1 — the helper super-admin logs in and gets their access token
curl -s -X POST https://api.ebda.app/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"<helper-admin@example.com>","password":"<password>"}' \
  | jq -r '.data.accessToken'

# Step 2 — they must pass their own MFA challenge first (if enrolled)
# POST /api/v1/auth/mfa/verify with their challengeToken + TOTP code

# Step 3 — call the admin endpoint to disable MFA for the locked-out user
curl -s -X POST https://api.ebda.app/api/v1/admin/users/<userId>/mfa/disable \
  -H "Authorization: Bearer <helper-admin-access-token>"
```

> Note: The helper admin must re-authenticate (pass their own TOTP challenge) before the admin endpoint will accept the request. This prevents a single compromised session from mass-disabling MFA.

After this call the locked-out user's `mfaEnabled` is `false`, their `tokenVersion` is incremented (all existing sessions invalidated), and they can log in with just email + password again.

---

## Option 3 — Last resort: CLI reset (requires server/DB access)

**Last resort only.** Since recovery codes became self-service (regenerate with step-up, above), staff should not need this for a user who still has a working authenticator or unused codes. Use it only when the user has lost BOTH and no other super-admin is available. Check first that the account's MFA state lives in the table the script edits (the Postgres `users` row); the identity service (`apps/accounts`, D1) holds its own `mfa_*` columns.

**Local dev (reads `DATABASE_URL` from `apps/api/.env`):**

```bash
npx tsx scripts/mfa-reset.ts user@example.com
```

**Production (requires the non-pooled `DIRECT_URL` — never use the pooler for this):**

```bash
DIRECT_URL="postgresql://..." npx tsx scripts/mfa-reset.ts user@example.com
```

Expected output: `MFA reset for user@example.com: 1 row(s)`

If it reports `0 row(s)` the email address is wrong — double-check before assuming the script failed.

### What the script does

- Sets `mfaEnabled = false`
- Clears `mfaSecret`, `mfaBackupCodes`, `mfaEnrolledAt`
- Increments `tokenVersion` by 1

**The `tokenVersion` increment is intentional.** Every existing access token for that user carries the old `tv` value and will be rejected by the auth middleware on the next request. This forces re-login everywhere (mobile, other browsers, API clients). Notify the user that they have been signed out and must re-enroll 2FA after logging back in.

---

## After recovery

Regardless of which option was used, advise the user to:

1. Log in with email + password (no TOTP required until they re-enroll).
2. Go to **Account → Security → Enable 2FA** and enroll a new authenticator. The enrollment page is reachable from the **Security & 2FA** shield icon in the sidebar footer (next to the logout button). Any protected route that returns `403 MFA_SETUP_REQUIRED` will also auto-redirect there.
3. Save the new backup codes in a secure location (password manager, printed paper in a safe).

---

## Notes on fail-open behavior

The revocation system (jti denylist + `tokenVersion` cache) is **fail-open** on Redis outage. If Redis is down when the reset script runs, the `tokenVersion` bump is persisted to the database immediately, but existing sessions will not be rejected until Redis recovers and re-populates the cache from the DB. During a Redis outage, old tokens temporarily remain valid. This is a documented tradeoff to prevent locking everyone out; pair with the Redis uptime alert in UptimeRobot.
