# OD-7a

> Section: 2026-10-01 — owner decisions 6 / 7 / 9 (branch `fix/owner-decisions-6-7-9`)

**Ruling OD-7a — the fingerprint covers `merchantId` as well as `apiKey` (two nullable columns, one
migration).** #2010 names both: `maskCredentials` masked both from ciphertext. Fixing one would
leave the second half of the same helper showing ciphertext fragments. The fingerprint is the last 4
characters of the plaintext as specified; it is not length-gated. Cost if wrong: a merchant id of 4
characters or fewer is shown in full (merchant ids are identifiers the provider also prints on
receipts, not secrets).
