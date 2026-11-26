#!/usr/bin/env bash
# Thin wrapper (F10): the merge gate is vendored from the foundation as scripts/foundation/merge-gate.sh; never edit that copy (`ebda-foundation
# check` fails on a changed byte). This only supplies the Store's defaults, so every existing call keeps working unchanged:
#   --repo      defaults to Ebda-AI-Studio/ebda-store
#   --workflows defaults to THIS checkout's .github/workflows (the required checks come from the Store's own workflows)
# usage: scripts/ci/merge-gate.sh <pr> <expected-head-sha> [options]   (options, test seams and exit codes: see scripts/foundation/merge-gate.sh)
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
has_repo=0; has_wf=0
for a in "$@"; do
  case "$a" in --repo) has_repo=1 ;; --workflows) has_wf=1 ;; *) ;; esac
done
extra=()
[ "$has_repo" = 1 ] || extra+=(--repo Ebda-AI-Studio/ebda-store)
[ "$has_wf" = 1 ] || extra+=(--workflows "$here/../../.github/workflows")
exec bash "$here/../foundation/merge-gate.sh" "$@" ${extra[@]+"${extra[@]}"}
