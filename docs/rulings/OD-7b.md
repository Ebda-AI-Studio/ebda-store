# OD-7b

> Section: 2026-10-01 — owner decisions 6 / 7 / 9 (branch `fix/owner-decisions-6-7-9`)

**Ruling OD-7b — answer-engine and wbs-integration keep their current mask in this PR.** The issue's
owner-question comment asked for one rule across `payment-settings`, `answer-engine/config.service.ts`
(also masks ciphertext) and `wbs-integration.routes.ts` (decrypts on read, shows first+last 4).
This PR's brief is the payment key display; the other two are different tables (and a store column)
with their own admin surfaces. Recorded here so they do not read as fixed. Cost if wrong: the
answer-engine key display still shows a ciphertext fragment, and the WBS GET still decrypts on every
read, until a follow-up applies the same save-time fingerprint.
