#!/usr/bin/env bash
# The ONE way to merge a PR into ebda-store: scripts/ci/merge-gate.sh <pr> <expected-head-sha> [options]
#
# WHY. #223 was merged 6 s after creation with ZERO checks; `gh pr merge` happily merges when nothing has reported
# yet. This gate refuses unless, on THREE consecutive polls:
#   - the PR head is exactly <expected-head-sha> (a prefix of 7+ chars is fine): you merge what you reviewed, and
#     the final `gh pr merge` is pinned to that commit (--match-head-commit)
#   - mergeable == MERGEABLE (not UNKNOWN, not CONFLICTING)
#   - at least one check exists (zero checks is "CI has not started", never "green")
#   - every check is COMPLETED with SUCCESS / SKIPPED / NEUTRAL (queued, in progress, failed, cancelled, timed out: no)
#   - every REQUIRED check is an explicit SUCCESS. The required list is DERIVED from .github/workflows by
#     scripts/ci/merge-gate-required.mjs (jobs that always run on a PR), so it cannot drift from the workflows.
# Only the LATEST run per check name counts (the rollup keeps old failed runs of the same name on the same sha).
# A failed/cancelled check or a moved head ends the run at once (exit 1). Pending checks are waited on, up to
# --max-wait-min (default 180); running out of time exits 2 and merges nothing.
#
# options: --repo OWNER/NAME (default Ebda-AI-Studio/ebda-store)  --polls N (3)  --interval S (30)  --max-wait-min M (180)
#          --dry-run (evaluate, never merge)
# test seams: MERGE_GATE_VIEW_CMD (prints the `gh pr view --json headRefOid,mergeable,statusCheckRollup` JSON),
#             MERGE_GATE_MERGE_CMD (replaces the final gh pr merge), MERGE_GATE_REQUIRED_JSON, MERGE_GATE_MAX_WAIT_S.
set -uo pipefail
pr="${1:?usage: merge-gate.sh <pr> <expected-head-sha> [--repo R] [--polls N] [--interval S] [--max-wait-min M] [--dry-run]}"
want="${2:?expected head sha required}"; shift 2
repo="Ebda-AI-Studio/ebda-store"; polls=3; interval=30; maxmin=180; dry=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) repo="$2"; shift 2 ;; --polls) polls="$2"; shift 2 ;; --interval) interval="$2"; shift 2 ;;
    --max-wait-min) maxmin="$2"; shift 2 ;; --dry-run) dry=1; shift ;;
    *) echo "merge-gate: unknown option $1" >&2; exit 64 ;;
  esac
done
[ "${#want}" -ge 7 ] || { echo "merge-gate: expected sha must be at least 7 chars" >&2; exit 64; }
here="$(cd "$(dirname "$0")" && pwd)"
required="${MERGE_GATE_REQUIRED_JSON:-$(node "$here/merge-gate-required.mjs" "$here/../../.github/workflows")}"
[ -n "$required" ] && [ "$(echo "$required" | jq 'length')" -gt 0 ] || { echo "merge-gate: could not derive the required checks; refusing" >&2; exit 2; }

view() {
  if [ -n "${MERGE_GATE_VIEW_CMD:-}" ]; then eval "$MERGE_GATE_VIEW_CMD"
  else gh pr view "$pr" --repo "$repo" --json headRefOid,mergeable,statusCheckRollup; fi
}

# one verdict word per poll: ok | wait:<why> | refuse:<why>
evaluate() {
  jq -r --arg want "$want" --argjson req "$required" '
    def nm: (.name // .context);
    def st: if .__typename == "StatusContext" then (if .state == "PENDING" or .state == "EXPECTED" then "IN_PROGRESS" else "COMPLETED" end) else .status end;
    def cc: if .__typename == "StatusContext" then (if .state == "SUCCESS" then "SUCCESS" else .state end) else (.conclusion // "") end;
    # statusCheckRollup keeps OLD runs of a check name on the same head sha: judge only the LATEST run per name
    # (by startedAt, else createdAt/completedAt; ties keep rollup order, last wins).
    def ts: (.startedAt // .createdAt // .completedAt // "");
    . as $p
    | ([($p.statusCheckRollup // [])[]] | to_entries | map(.value + {__i: .key}) | group_by(nm) | map(sort_by([ts, .__i]) | last)) as $c
    | if ($p.headRefOid | startswith($want) | not) then "refuse:head moved to \($p.headRefOid[0:9]) (expected \($want))"
      elif [$c[] | select(st == "COMPLETED" and (cc | IN("SUCCESS","SKIPPED","NEUTRAL") | not)) | nm] | length > 0
        then "refuse:failing check(s): \([$c[] | select(st == "COMPLETED" and (cc | IN("SUCCESS","SKIPPED","NEUTRAL") | not)) | nm] | join(", "))"
      elif ($c | length) == 0 then "wait:no checks have reported yet"
      elif [$c[] | select(st != "COMPLETED") | nm] | length > 0 then "wait:not finished: \([$c[] | select(st != "COMPLETED") | nm] | join(", "))"
      elif ($p.mergeable != "MERGEABLE") then "wait:mergeable=\($p.mergeable)"
      elif ($req - [$c[] | select(cc == "SUCCESS") | nm]) | length > 0 then "wait:required check(s) without an explicit SUCCESS: \(($req - [$c[] | select(cc == "SUCCESS") | nm]) | join(", "))"
      else "ok" end'
}

deadline=$((SECONDS + ${MERGE_GATE_MAX_WAIT_S:-$((maxmin * 60))})); streak=0; sha=""
while :; do
  json="$(view 2>/dev/null)" || json=""
  if [ -z "$json" ]; then v="wait:could not read the PR"; else v="$(echo "$json" | evaluate)"; sha="$(echo "$json" | jq -r .headRefOid)"; fi
  case "$v" in
    ok) streak=$((streak + 1)); echo "merge-gate: PR $pr green poll $streak/$polls"
        if [ "$streak" -ge "$polls" ]; then
          if [ "$dry" = 1 ]; then echo "merge-gate: DRY RUN, would merge $pr at $sha"; exit 0; fi
          if [ -n "${MERGE_GATE_MERGE_CMD:-}" ]; then eval "$MERGE_GATE_MERGE_CMD"; exit $?; fi
          gh pr merge "$pr" --repo "$repo" --squash --delete-branch --match-head-commit "$sha"; exit $?
        fi ;;
    refuse:*) echo "merge-gate: REFUSED PR $pr: ${v#refuse:}" >&2; exit 1 ;;
    *) streak=0; echo "merge-gate: waiting (${v#wait:})" ;;
  esac
  if [ "$SECONDS" -ge "$deadline" ]; then echo "merge-gate: gave up after ${maxmin} min; nothing merged (last: ${v#*:})" >&2; exit 2; fi
  sleep "$interval"
done
