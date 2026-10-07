/**
 * Password-reset link lifetime, in minutes. ONE number for the API (the token
 * row's `expiresAt`, the email copy) and the Ebda Store pages that tell the
 * merchant how long the link lasts, so the promise on screen can never drift
 * from the behaviour. 15 (S5-2, 2026-09-22 security audit; Ruling
 * EBDA-PWRESET-2): a link outstanding longer is a longer window for a
 * forwarded or intercepted email to take over the account.
 */
export const PASSWORD_RESET_TTL_MINUTES = 15;
