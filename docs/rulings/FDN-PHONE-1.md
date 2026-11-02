# FDN-PHONE-1

> Section: Ebda foundation adoption (2026-10-29)

**Ruling FDN-PHONE-1: the Store's phone STORAGE format (`normalizePhoneForStorage`, MONEYB-7) is unchanged; only the buyer-key input goes through the foundation's `normaliseE164`.**
`toE164` and `buyerKeyFor` now call the vendored `normaliseE164` / `buyerKey` (the Ebda Chat implementation, canonical per audit CODE-10); the 36 phone vectors and 8 buyer-key vectors give the same output as before. Changing what orders store is a data migration and a separate PR. Cost if wrong: a landline or foreign number is still stored as digits rather than E.164 until that data PR lands; buyer keys are unaffected.
