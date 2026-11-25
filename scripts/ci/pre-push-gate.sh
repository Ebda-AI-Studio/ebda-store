#!/usr/bin/env bash
# Thin wrapper (F10): the light pre-push gate (action pins, gitleaks on the push range, prettier on the changed files) is vendored from the
# foundation as scripts/foundation/pre-push-gate.sh; never edit that copy (`ebda-foundation check` fails on a changed byte). It runs the Store's own
# steps, related tests and repo scanners (MAC-LIGHT-1, PREPUSH-2/3/4/5/8), LAST from scripts/ci/pre-push-extra.sh. Run from the repo root (the hook does).
set -euo pipefail
exec bash "$(dirname "${BASH_SOURCE[0]}")/../foundation/pre-push-gate.sh" "$@"
