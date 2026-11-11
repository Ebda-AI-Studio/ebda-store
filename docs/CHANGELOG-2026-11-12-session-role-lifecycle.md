# 2026-11-12 session and role lifecycle (audit backfill-auth-security: ID-02, ID-05, ID-06, ID-07, ID-08, TEN-2, TEN-3, TEN-4)

- **ID-02** `authenticateAccounts`: a token with the `pa: super_admin` claim is always checked LIVE (also on plain reads), uncached
  (skips the 30 s account-state cache) and only honoured while the account's CURRENT role is `super_admin` (else 401 TOKEN_REVOKED).
  Role-change write paths: admin `PUT /admin/users/:id` (setAccountRole + revokeIdentityUser) and staff-invite accept
  (setAccountRole); both end the identity sessions at the identity service (`setRole` revokes all) and drop the local account-state cache.
  Staleness class NEVER-stale, no TTL: a demotion is seen on the next request on every isolate.
- **TEN-2** impersonation tokens carry `impSid` (the admin's identity session). `authenticate` / `optionalAuthenticate` check LIVE,
  uncached, that the impersonator's session is not revoked and the account is still an active `super_admin`.
  New `POST /auth/impersonation/end` (impersonation token only) denylists the token's jti and audits `admin.impersonate.end`.
- **TEN-3** `rejectImpersonated` added to notification provider credentials PUT/DELETE; sweep also added it to merchant webhook endpoints
  (POST/PATCH/DELETE: an exfiltration channel), MCP write switch and merchant-key revoke.
- **TEN-4** design: `requireRecentLogin` (`middleware/require-mfa.ts`): the identity token's `auth_time` (interactive login, with the
  second factor when the account has one) must be at most 30 min old, else `403 STEP_UP_REQUIRED` (403, not 401, so clients do not
  loop on refresh, which keeps the same auth_time). Applied to key minting/revoking (merchant + agent keys, MCP write switch), staff
  add/remove/revoke-invite, notification provider credentials, payment provider create and credential swap. Client UI to send the
  user back through sign-in on `STEP_UP_REQUIRED` is a follow-up in the admin app.
- **ID-05** `/auth/logout` refuses (403 ORIGIN_NOT_PERMITTED) a cross-site request that carries an identity-service session (Origin not a
  platform origin, or no Origin and `Sec-Fetch-Site: cross-site`). Customer logout (storefront on merchant domains) is unchanged.
- **ID-06** identity service: MFA disable, passkey delete and phone change revoke every OTHER session (and refresh tokens) and send the
  new `credential_changed` notice (Egyptian Arabic + English, master brand) through `MAILER.sendNotice`.
- **ID-07** staff invite never answers 409 ROLE_CONFLICT: a super_admin / customer / unusable address gets the same 202
  `invitation_sent` as a real invite, with nothing mailed (audit row `staff.invite_refused`).
- **ID-08** `JWT_PREVIOUS_PUBLIC_JWKS` entries need their own `exp` (unix s); expired or exp-less retired keys are not published. See ENVIRONMENT.md.
