/**
 * Hidden form field real people never see or fill (the same name merchant signup uses,
 * `SIGNUP_HONEYPOT_FIELD` in apps/api/src/services/signup-abuse.service.ts). A non-empty
 * value marks the submission as a bot; the API answers success and drops it.
 */
export const CONTACT_HONEYPOT_FIELD = 'company_site' as const;
