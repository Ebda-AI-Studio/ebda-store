# Merge train for ebda-store: fewer CI runs per merge (options, numbers, recommendation; no code yet)

Status: proposal for the main controller's decision. Author: track 3. Date: 2026-11-17.

## The problem, in numbers

Measured today (main controller): about 67 job-minutes of CI per PR, plus one main CI run per 3 merges, on 2 heavy runners = 120 job-minutes per hour. That is about 92 job-minutes per merge (67 + a main run of roughly 75 / 3) and about 1.3 merges per hour: 53 approved PRs are about 40 hours. Faster jobs do not fix a ratio; the number of CI runs per merged PR has to fall.

## Check first (as asked): can GitHub's own merge queue do this?

Verified here, read-only:

- The org is on the `enterprise` plan (the trial that started 2026-11-05; `private_repos` unlimited). Merge queue is an Enterprise Cloud feature for private repos; I could not find the plan rule in the pages I fetched, so the final proof is enabling it (see "Spike").
- The GraphQL schema has what the drain needs: `MergeQueue` (entries, configuration), and `enqueuePullRequest(input: { pullRequestId, expectedHeadOid, jump })`. `expectedHeadOid` pins the head SHA, which is the same property `merge-gate.sh` gets from `--match-head-commit`. `gh pr merge` on a queued branch enqueues (or enables auto-merge until the required checks pass).
- Today `ebda-store` has no queue (`mergeQueue(branch:"main")` is null). The org ruleset `ebda-main-protection` has only `deletion`, `non_fast_forward`, `pull_request`: GitHub requires NO status check; `merge-gate.sh` enforces them in the script.
- Settings that map straight onto the train: max group size (1-100), min group size, wait time, build concurrency (1-100), status-check timeout, merge method, and "only merge non-failing pull requests".
- How a group works (docs): each entry gets a temporary branch `gh-readonly-queue/main/...` = latest main + every PR ahead; a `merge_group` event runs CI ONCE on that branch; when a group fails, the PR it was built for is removed and the next group is rebuilt without it (a linear drop-and-rebuild, not a bisect); a conflict with main removes the PR. The workflow must list `merge_group:` in `on:`, and the required checks must be configured (ruleset) because the queue waits for exactly those.
- Self-hosted runners work: `merge_group` runs the same jobs with the same `runs-on` as any event. Our `ci.yml` full lane is already `if: github.event_name != 'pull_request'`, so a `merge_group` run selects the full lane (build, unit shards, integration, e2e, security) without a rewrite of those conditions; the 29 other `event_name` references need an audit (the `changes` job and the concurrency group).

## Options

### Q. GitHub merge queue (recommended)

A new ruleset for `ebda-store` only (leave `ebda-main-protection` alone): `merge_queue` (squash, max group size N, min group size N, wait 10 min, build concurrency 1, "only merge non-failing PRs" on), `required_status_checks` = the list `scripts/ci/merge-gate-required.mjs` already derives from the workflows. CI gets `merge_group:` in `on:`. The drain stops calling `gh pr merge` and calls `enqueuePullRequest(expectedHeadOid)` after it has checked the stamp (controller/money-review from an allowed creator, MONEY-SHA-1b), the AI-review label and the creator rule on THAT head. Those per-PR gates stay in the drain (they are control-plane rules GitHub cannot express); the queue only batches CI and merges.

- Build effort: about 2 days (workflow `merge_group` trigger and its audit, ruleset, drain change, tests with the `gh` stub), plus the PR-lane cut below.
- Risks: (a) anyone with write access can enqueue by hand and skip the drain's stamps, exactly as `gh pr merge` can today (not a regression); (b) the queue rebuilds a group when one PR is dropped, so a flaky test costs a rebuild (turn "only merge non-failing" on, keep the retry-on-infra-flake rule); (c) the required-check list must exist on both `pull_request` and `merge_group`, and jobs skipped by `changes` must still report (the existing aggregator jobs already do that for PRs); (d) Enterprise is a trial until about 2026-12-05: keeping the queue and the existing rulesets needs the plan kept (1 seat is about $21 per month per the standing note, with the add-on budgets at $0). Cost if wrong: the queue is switched off with one ruleset change and the drain falls back to `gh pr merge`; nothing else depends on it.

### T. Our own train (drain + temp branch)

The drain builds `train/N` = main + the top N stamped PRs (stops at the first conflict, drops that PR), pushes it, `ci.yml` runs on `train/**`, green means it merges the N PRs in order, red means it bisects by halves (log2 N rebuilds, better than the queue's linear drop). Full control over "the train run counts as main's green". Costs: about 5-7 days (temp branch lifecycle, bisect state, partial-merge recovery, a CI trigger on `train/**`, tests), and every edge case the queue already handles (conflict with main moving under the train, concurrent pushes, cancelled runs, orphan temp branches) becomes ours. Choose T only if the queue is unavailable after the plan decision or its linear drop-and-rebuild proves too costly.

### P. Do nothing to merging, only cut PR CI

Keep merging one at a time but move the heavy tiers (integration, e2e, builder-e2e, security) off the PR lane to a nightly/main lane. Cheapest (a CI-config change) and it composes with Q or T; on its own it fixes cost per PR but not main CI per merge.

## The numbers (what each option buys)

Assumptions, stated so they can be corrected: 120 job-min/hour; PR CI today 67; one full run on a train or main branch about 75; a light PR lane (lint, typecheck, affected unit tests) about 20 job-min (an ESTIMATE, not measured: the first build step is to measure it from the last runs); a train build fails and is rebuilt 30% of the time (today 3 of the top 8 PRs fail their own CI, so this is a guess to refine).

| Scenario                                                                    | job-min per merge          | merges per hour | 53 PRs       |
| --------------------------------------------------------------------------- | -------------------------- | --------------- | ------------ |
| Today (67 + main run every 3)                                               | about 92                   | 1.3             | about 40 h   |
| Train/queue ONLY, PR CI unchanged, N=4, main push CI still runs             | (4x67 + 75 + 75) / 4 = 105 | 1.1             | 46 h (worse) |
| Train/queue only, PR CI unchanged, the queue run counts as main's green     | (4x67 + 75) / 4 = 86       | 1.4             | 38 h         |
| Train/queue + light PR lane (20), N=4, counted as main's green, 30% rebuild | (4x20 + 75x1.3) / 4 = 44   | 2.7             | about 20 h   |
| Same, N=5                                                                   | (5x20 + 97) / 5 = 39       | 3.0             | about 18 h   |
| Same but main push CI still runs on every train                             | (4x20 + 97 + 75) / 4 = 63  | 1.9             | about 28 h   |
| Light PR lane alone (P), merge one at a time, main every 3                  | 20 + 25 = 45               | 2.7             | about 20 h   |

Reading: the train or queue by itself does NOT help while every PR still pays its full 67 job-minutes; the gain comes from moving the heavy CI from "once per PR" to "once per group of N" (the light PR lane + one full run per group). Option P alone is about as large a win as the full design in this model, because the main run is only 25 of the 92 job-minutes; the queue adds the "batch of N" on top and removes the main run per merge. The floor, with an infinite train, is the light lane alone: 20 job-min per PR, 6 merges per hour, about 9 hours for 53.

## Recommendation

1. Start with P now (small, reversible, composes): decide the PR lane and measure it.
2. Build Q (GitHub merge queue) on top, because it is configuration plus a bounded drain change, it is a native, supported path with the SHA pin, and it removes the temp-branch lifecycle we would otherwise own. Keep T as the fallback.
3. Make the queue run count as main's green: the `push` CI on main after a queue merge repeats work the queue already did. Options: skip the full lane on a push whose tree equals the tested group tree (compare the tree SHA with the latest successful `merge_group` run), or point the drain's main-green check (`--main-workflow`) at the `merge_group` run. This is the only part of the design that touches the drain's main gate, so it needs its own review.

## Spike (before building, about half a day, no production change)

Create a scratch private repo in the org (needs the controller's OK; it is empty and deletable), copy a minimal workflow with `merge_group:` and `runs-on` the `ebda-mac-light` label, enable the merge queue ruleset, enqueue two PRs, and record: (1) that the plan allows it, (2) that a self-hosted runner picks up the `merge_group` run, (3) the group behaviour with max size 3 (one CI run for the group, what happens when one PR fails), (4) that `enqueuePullRequest` with `expectedHeadOid` refuses a moved head.

## Decisions needed

- Option Q (with P first), T, or P only.
- N (3 or 4 or 5; the model says 4-5), and the wait time.
- Keep Enterprise past the trial (about $21 per seat per month): needed for Q and for the existing org rulesets.
- Scratch repo for the spike: yes or no.

## Unknowns (not measured)

The light PR lane's real job-minutes; the real failure/rebuild rate of a group; whether `needs:` waves make `queued` job counts misleading for the lease (a known unknown from the main-first work); whether the merge queue and the main-first lease interact (the lease cancels queued PR runs while main waits; `merge_group` runs are a different event and must be added to its protected set).
