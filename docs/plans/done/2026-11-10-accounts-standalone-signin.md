# accounts.ebda.app standalone sign-in page (launch-map ACCOUNTS-PAGE)

Date: 2026-11-10 · Branch: `feat/accounts-standalone-signin` · Ruling: ACCOUNTS-PAGE-1

## Finish line

- Must work: `GET accounts.ebda.app/login` renders an Ebda AI Studio sign-in page (ar default, en via `?lang=en` /
  Accept-Language); password -> (optional TOTP / backup code) -> session cookie -> browser goes to an allowlisted `return`.
- Exercised: `GET /`, `GET /login`, `GET /sign-in.js|css`, `POST /login`, `POST /login/mfa` from origin `https://accounts.ebda.app`.
- Must NOT change: `store.ebda.app/login` (no admin file touched); every other accounts route; the `__Host-ebda_rt`
  cookie attributes; the login/MFA limiters; `/sign-in` (still 302 to the Store sign-in).
- Done: workerd tests green (security list below, each mutation-checked), lint + typecheck green, Playwright at 390/1280
  ar/en against `wrangler dev`, PR open + green.

## What exists (read 2026-11-10)

- Session = `__Host-ebda_rt` (no Domain, Path=/, Secure, HttpOnly, SameSite=Lax) set by `POST /login` and `POST /login/mfa`
  on accounts.ebda.app itself. The admin page posts cross-origin (same-site) with `credentials: include` and `aud: 'store'`.
- CSRF = `originGuard` (refuses `sec-fetch-site: cross-site`, Origin must be in `ALLOWED_ORIGINS`) + `json()` (only
  `application/json`, so no preflight-less form post). `originAudience`: an Origin may only ask for its `ORIGIN_PRODUCTS` aud.
- Limiters: `hit(email, ip, LOGIN)` before the password check; `hit(user, ip, SECOND_FACTOR)` on MFA. Server-side, per endpoint.
- Return allowlist = `apps/admin/src/lib/sign-in-return.ts` `safeSignInReturn` (Ruling SIGNIN-RETURN-1).
- Ebda Chat (`ebda-whatsapp/web/src/data/auth.ts`) ALREADY sends signed-out people to
  `${accountsUrl}/login?product=chat&return=<url>` -> no Chat change needed: it lands on the new page as soon as it deploys.

## Design (smallest)

1. `GET /login` renders the page (new `apps/accounts/src/sign-in-page.ts`, pure). `GET /` 302s to `/login` on the SAME host
   (carrying only `product`, `return`, `lang`). `/sign-in` keeps its 302 to the Store sign-in (out of scope, unchanged).
2. The page's script and CSS are served from the Worker (`/sign-in.js`, `/sign-in.css`): CSP `default-src 'none';
script-src 'self'; style-src 'self'; connect-src 'self'; img-src https://ebda.app; form-action 'none'; base-uri 'none';
frame-ancestors 'none'`. `form-action 'none'` + `method=post`: with no script the browser sends nothing (no password in a URL).
3. The script calls the SAME endpoints with the SAME bodies as the admin page: `POST /login {email,password,aud:'store'}`,
   `POST /login/mfa {challenge, code|backupCode}`. No new auth logic, no new secret. To pass the existing CSRF/audience
   checks the page origin is added to two wrangler vars: `ALLOWED_ORIGINS += https://accounts.ebda.app`,
   `ORIGIN_PRODUCTS += https://accounts.ebda.app=store` (same as store/orders).
4. Return: `?return=` (Chat's existing contract) or alias `?return_to=`, validated SERVER-SIDE by the admin's own
   `safeSignInReturn` (one allowlist, imported, not copied): https only, exact host in {store, wa, orders}.ebda.app + ebda.app,
   no userinfo/port/backslash/control chars. Anything else -> `https://store.ebda.app/`. The validated URL is embedded
   (HTML-escaped) in a data attribute; the script re-checks `https://` before `location.assign`.
   4b. `product` (Chat's contract, controller 2026-11-10): allowlist `whatsapp`/`chat` -> "Sign in to Ebda Chat" /
   «تسجيل الدخول لابدأ شات», `store` -> Ebda Store, absent/unknown -> generic studio sign-in; the raw value is never
   rendered. End-to-end test of Chat's flow: 401 `/token` -> `/login?product=whatsapp&return=<wa>` -> sign in -> `/token?aud=whatsapp` 200.
5. Outcomes mirror the admin: `mfaRequired` -> code step (TOTP or backup code); `secondFactorRequired` -> the admin's
   sentence + a link to the Store sign-in (passkey lives there); `mfaEnrollmentRequired` -> `store.ebda.app/account/security`.
   Errors are fixed bilingual sentences keyed by the admin's `signInMessageKey` mapping, never the API's text.
6. Passkey, forgot-password and sign-up are links to the Store pages (with `product`/`return` kept for the passkey link):
   passkeys need `PASSKEY_ORIGINS` + WebAuthn client code on a new origin, not a launch-day change (Ruling ACCOUNTS-PAGE-1).

## Security tests (workerd, `apps/accounts/test/sign-in-page.test.ts`)

open redirect (other host, `//evil`, `https:evil`, backslash, `%2F%2F`-encoded, userinfo `https://ebda.app@evil`, http,
lookalike), cookie attributes from a page-origin login, CSRF (cross-site, foreign Origin, text/plain) still refused,
limiter still locks after the budget, no credential in the rendered page/URL, headers (CSP, noindex, no-store,
frame-ancestors), unchanged routes answer as before.

## Rollback

Revert the PR (code + the two vars travel together). Admin is untouched, so a broken page never blocks the Store sign-in.
