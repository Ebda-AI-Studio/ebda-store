# PASSKEY-12

> Section: 2026-10-15 — Phase B1 Qamar (B1-\*)

Ruling PASSKEY-12 — the step-up proof is bound to the USER and the SESSION: Redis key `passkey:stepup:<userId>:<sha256(access-token jti)>` with the user id as the value (checked on read), 300 s, written only by the server (`stepUp`, or the route right after a passkey sign-in, for the NEW session's jti). A session without a jti can never hold one; a proof from session X does not authorise session Y of the same user, nor user V with X's id; nothing the client sends decides it. Evidence: `passkey.service.test.ts` (X vs Y on register / rename / remove, no-id session, U vs V including a planted key, raw session id absent from the key) and `passkey.routes.test.ts` (HTTP: another jti refused; a passkey sign-in opens only the new session). Cost if wrong: an access-token refresh (new jti) inside the 5-minute window asks for the password again.
