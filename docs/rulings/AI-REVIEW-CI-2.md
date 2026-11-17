# AI-REVIEW-CI-2: every event ends in a real "AI review" check; staleness is freshness-based, never a strip

Ruling AI-REVIEW-CI-2 (supersedes the earlier "every push strips" draft; follows main's AI-REVIEW-LABEL-1 / #808 and register Ruling RF-710) - `classify` NEVER removes `ai-review-passed`. A label set by the controller after an independent review survives a size refusal, an infra failure or a push; whether it still counts is decided by its freshness: the label is valid only when its latest `labeled` event is newer than the head commit (`.github/ai-review/label-fresh.mjs`, the merge drain's rule). Fork PRs keep their own strip in `fork-gate` (no bot review ever runs on them).

Every subscribed event must end in a real (non-skipped) `AI review` check: `not-risky` and `state-check` join `review`, `manual-pass` and `fork-gate`; `state-check` fails unless a risky PR carries a fresh label and never strips. A test replays every job's `if:` over all events x draft x fork x risky.

Hardening: `classify` also runs for drafts and for an `edited` event that changed the base branch; one queued (never cancelled) concurrency group per PR; the review labels only a head that is still the PR head. The Claude CLI is installed with `--ignore-scripts` and then `install.cjs` is run explicitly, verified by `claude --version` before the review.

Cost if wrong: an AI-review re-classify keeps a stale approval label; mitigated by label-fresh.mjs and the DRAIN `reviewed_at_head` check. Residual: the committer date is chosen by the pusher, so a backdated head commit can make an older label look newer.
