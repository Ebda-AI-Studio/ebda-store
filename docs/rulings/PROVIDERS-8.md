# PROVIDERS-8

> Section: 2026-10-07 — Provider catalog, Batch 0 + payments Batch 1 (PROVIDERS-\*)

Ruling PROVIDERS-8 — the regenerated `docs/security/defence-mutation-record.md` (184 defences, 177 killed) reports 7 ERROR (stale-spec) rows; 4 of them were KILLED in the committed record (`inngest-path-has-own-bucket`, `sms-optout-mac-not-session-secret`, `campaign-unsubscribe-mac-not-session-secret`, `review-link-mac-not-session-secret`), the rest were already stale on main. None is caused by this branch: it does not touch `apps/api/src/index.ts`, `lib/sms-consent.ts`, `lib/campaign-unsubscribe-token.ts`, `lib/review-token.ts` or `apps/web/middleware.ts` (`git diff origin/main` is empty for them) — main's code moved after main's record was written, so their spec `find` strings are stale. Left for their owners rather than re-pointed blind here. All 8 new provider defences are KILLED. Cost if wrong: those 4 defences have no live mutation proof until their specs are updated.
