# AI-REVIEW-CI-2: approval is never carried across pushes by automation

Ruling AI-REVIEW-CI-2 (foundation Ruling AIR-6; the controller's "AIR-2" decision of 2026-11-11) - Approval is never carried by automation across pushes; a base retarget strips it. Every push strips `ai-review-passed`, and so does an `edited` event that changed the base branch (title/body edits do not, and cannot cancel a running review). The controller re-applies the label after verifying the PR-only diff is unchanged, and avoids mass `gh pr update-branch` on approved PRs. A marker-comment approach (store #705, foundation #52) was closed after security review: forgeable by any writer, base retarget kept the label, label race.

Cost if wrong: manual re-label after each main merge.
