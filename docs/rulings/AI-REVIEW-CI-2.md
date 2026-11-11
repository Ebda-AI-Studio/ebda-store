# AI-REVIEW-CI-2: approval is never carried across pushes by automation

Ruling AI-REVIEW-CI-2 (foundation Ruling AIR-6; the controller's "AIR-2" decision of 2026-11-11) - Approval is never carried by automation across pushes; a base retarget strips it. Every push strips `ai-review-passed`, and so does an `edited` event that changed the base branch (title/body edits do not, and cannot cancel a running review). The controller re-applies the label after verifying the PR-only diff is unchanged, and avoids mass `gh pr update-branch` on approved PRs. A marker-comment approach (store #705, foundation #52) was closed after security review: forgeable by any writer, base retarget kept the label, label race.

Every subscribed event must end in a real (non-skipped) `AI review` check: `not-risky` and `state-check` join `review`, `manual-pass` and `fork-gate`; `state-check` fails unless a risky PR carries the label and never strips. A test replays every job's `if:` over all events x draft x fork x risky.

Hardening (foundation AIR-6): the strip runs on every push-like event including drafts; one queued (never cancelled) concurrency group per PR; `state-check` and `fork-gate` honour the label only if its latest `labeled` event is newer than the head commit (`.github/ai-review/label-fresh.mjs`, the drain's rule; residual: a pusher can backdate the committer date); the review labels only a head that is still the PR head. The Claude CLI is installed with `--ignore-scripts` and then `install.cjs` is run explicitly, verified by `claude --version` before the review.

Cost if wrong: manual re-label after each main merge; a title edit while a review is still running can leave a red `state-check` until the next event.
