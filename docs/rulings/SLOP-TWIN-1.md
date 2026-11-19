# SLOP-TWIN-1

> Section: 2026-11-19 - slop guard, deliberate byte-equal twins (PR from the #968 review)

**Ruling SLOP-TWIN-1 - the slop guard honours `// pq-allow(duplicate-helper): twin of <path>` ONLY as a verified pair.**
The annotation goes on the line directly above the function (or on its line), in BOTH copies, each naming the other. It is accepted
only when (a) the named twin file exists, (b) that file has the same function with an identical (normalised) body, and (c) the twin
carries the matching annotation pointing back. A function that claims a twin but fails any of the three is itself a violation
(`duplicate-helper|<file>|<name>|twin-invalid`), so body drift, a deleted twin or a one-sided annotation fails the PR. An
un-annotated duplicate, or a third copy, still fails. Why: some code must exist twice because one side cannot import the other (the
API Worker cannot import `packages/repo`, e.g. `revenue.ts` / `revenue-sql.ts`); a bare `pq-allow` would let any duplicate hide, and
rewriting the helpers to dodge the detector (arrow consts) was rejected. The baseline cannot absorb it: the guard judges against the
BASE branch's baseline. Tests: `tests/unit/slop-twin-allow.test.ts` (accepted pair, missing back-reference, wrong back-reference, body
drift, missing twin, third copy, un-annotated duplicate).
Cost if wrong: a reviewer trusts the twin annotation and an equal-looking pair drifts in a way the normalised-body hash does not see (whitespace/comments only), which is harmless; a semantic drift changes the hash and fails.
