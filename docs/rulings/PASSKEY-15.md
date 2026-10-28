# PASSKEY-15

> Section: 2026-10-15 — Phase B1 Qamar (B1-\*)

Ruling PASSKEY-15 (review M2, M3) — limits: sign-in `/begin` is per store host + IP at 300 per 15 minutes (was 60 per IP across everything; a carrier NAT exhausted it), because the real brute-force guard is the shared account lockout; the login pages fetch options ON DEMAND (first focus of the email field, or the button), not on load; `/step-up` is keyed on the authenticated user (10 per 15 minutes), not on a body field an attacker rotates. Evidence: `tests/unit/passkey-limiters.test.ts`, `apps/admin/src/app/login/page.passkey.test.tsx`, `apps/web/src/app/auth/login/LoginClient.passkey.test.tsx` (no ceremony on load, once on focus). Cost if wrong: one more request when the field is focused; autofill suggestions appear a beat later.
