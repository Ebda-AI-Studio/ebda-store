# Refresh-token rotation hardening (auth-critical)

Date: 2026-06-09
Branch: `fix/fwb-refresh-token`
Author: Ahmad Sharaf

## What already exists (do NOT rebuild)

FWB already has a DB-backed rotating refresh-token system in `AuthService`:

- `RefreshToken` table (`packages/database/prisma/schema.prisma`) with
  `revokedAt`, `revokedReason`, `replacedById` for reuse-detection.
- `refreshTokens()` rotates: issues a new token, marks the old `rotated`,
  back-links via `replacedById`. A presentation of an already-revoked token
  triggers family revocation (`reuse_detected`) → 401 `TOKEN_REUSED`.
- `revokeAllSessions()` bumps `tokenVersion` (access-token bulk revocation)
  AND revokes all live refresh tokens — a single call kills access + refresh.
- MFA composes: `login()` returns a challenge token (audience
  `force-mfa-challenge`); only `issueSessionFor()` (login direct OR after
  `/auth/mfa/verify`) mints the real access+refresh pair.
- Web `ApiClient` already does transparent refresh-on-401 with concurrency
  dedup (`refreshAccessToken`, `refreshPromise`).
- Admin `AuthProvider.checkAuth` does refresh-on-401 on mount.

## The actual gaps this PR closes

1. **Access token is 30 days** (`JWT_EXPIRES_IN=30d`). Rotation never triggers
   in practice — the access token effectively never expires, so the short-lived
   / silently-refreshed access-token security posture doesn't exist. Shorten the
   access token to **30 min** while keeping the **30-day refresh window** so the
   user-facing "always signed in" UX is unchanged (refresh lifetime, not access
   lifetime, governs the session length).

2. **Refresh token only lives in the JSON body + localStorage**, never in its own
   HTTP-only cookie. A pure-cookie browser (no localStorage mirror) cannot
   refresh. Add a dedicated `refresh_token` HTTP-only cookie scoped to the
   refresh path, `SameSite=None; Secure` cross-origin like the access cookie.
   `/auth/refresh` accepts the refresh token from **body OR the cookie**.

3. **Admin `lib/api.ts` does NOT transparently refresh on 401** — only
   `checkAuth` (mount) does. Once the (now-short) access token expires mid-session
   every `apiRequest`/`apiFetch` 401s until a remount. Add a single-flight
   refresh-and-retry to admin `apiRequest` + `apiFetch`, matching the web client.

4. **`/auth/mfa/verify` mints a session but never sets the access/refresh
   cookies** (only `auth.routes.ts` login/register did). Set both cookies on the
   MFA-verify response too, so post-MFA the cookie path works identically.

## Design

### Token lifetimes (config)

- `JWT_EXPIRES_IN` default `30d` → **`30m`** (access token short, silently
  refreshed). Overridable via env.
- `REFRESH_TOKEN_EXPIRES_IN` stays `365d`? No — align the refresh-cookie maxAge,
  the DB-row expiry, and the JWT `exp` to the SAME window. Keep the existing
  365-day refresh lifetime (the admin PWA gap-tolerance rationale in config.ts).
  The "30-day always-signed-in" floor is satisfied a fortiori by a 365-day
  refresh token; we do NOT shorten it.
- New: derive the access-cookie maxAge from `jwtExpiresIn` is unnecessary — a
  cookie can outlive the JWT; the JWT `exp` is the real gate. Keep the access
  cookie maxAge at the refresh window so the browser keeps presenting it (a
  stale-but-present access cookie just 401s and triggers refresh). Simpler:
  keep access-cookie maxAge = 30 days (unchanged) — it being longer than the
  JWT is harmless (middleware rejects on `exp`).

### Cookies (`auth.routes.ts`)

- `token` (access) — unchanged name/options.
- NEW `refresh_token` — HTTP-only, `SameSite=None; Secure` in prod, `path=/`
  (so it is sent to `/api/v1/auth/refresh`; the API mounts auth under
  `/api/v1/auth`, and cookies are path-prefix matched — `/` covers it. We do
  NOT scope to `/api/v1/auth/refresh` because the access cookie is already
  path `/` and Next rewrites/proxies could differ; matching the existing
  access-cookie path avoids a subtle "cookie not sent" bug). maxAge = refresh
  window (365d).
- `setRefreshCookie(res, token)` / `clearRefreshCookie(res)` helpers mirror the
  access-cookie helpers.
- Login, register-after-verify (login path), `/auth/refresh`, and
  `/auth/mfa/verify` all set BOTH cookies. Logout + logout-all + erase clear both.

### `/auth/refresh`

- Accept refresh token from `req.body.refreshToken` OR `req.cookies.refresh_token`
  (body wins for the Bearer/localStorage clients; cookie is the pure-browser
  path). 400 only when neither is present.
- On success, set BOTH the new access cookie AND the new refresh cookie
  (rotation → the browser's refresh cookie must be replaced or the next refresh
  reuses the now-rotated token and self-revokes the family).

### MFA verify (`mfa.routes.ts`)

- After `issueSessionFor`, set both cookies before responding.

### Frontends

- Admin `lib/api.ts`: add `refreshAccessToken()` single-flight + 401 retry in
  `apiRequest` and `apiFetch` (skip for `/auth/` endpoints to avoid loops).
  Mirror new access/refresh tokens to localStorage. `credentials:'include'`
  already set.
- Web `lib/api.ts`: already correct. No change needed beyond confirming the
  refresh cookie path works (cookie is sent automatically via
  `credentials:'include'`).

## Tests (vitest)

Unit/integration against `AuthService` with the real test DB (matches
`tests/integration/auth-gdpr.test.ts` pattern of creating users via prisma):

1. **rotation issues a new token** — refresh returns a different refresh token;
   old row is `revokedAt!=null` with `revokedReason='rotated'` and `replacedById`
   pointing at the new row.
2. **reuse-detection revokes the family** — present an already-rotated token →
   401 `TOKEN_REUSED`; all of the user's refresh tokens are now revoked.
3. **a normal refresh keeps the session** — the new access token verifies and
   carries the live `tv`; `/auth/me`-equivalent (decode) succeeds.
4. **MFA still gates** — a user with `mfaEnabled` + `mfaSecret` logging in gets
   `mfaRequired` (no tokens); only after `issueSessionFor` are tokens minted.
5. **revokeAllSessions kills refresh** — after it, an unused (not-yet-rotated)
   refresh token is rejected (its row is revoked → reuse path → 401).

## New env vars (document in PR)

- None strictly new. `JWT_EXPIRES_IN` default changes `30d`→`30m`; prod can pin
  it via the existing env var. `REFRESH_TOKEN_EXPIRES_IN` unchanged (`365d`).

## Verify locally

- symlink node_modules, `npx tsc --noEmit` api + admin/web touched files,
  run auth tests. CI (self-hosted) is the full gate (needs Postgres+Redis
  services the local box may lack).
