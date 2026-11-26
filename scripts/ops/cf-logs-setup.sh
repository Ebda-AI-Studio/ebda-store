#!/usr/bin/env bash
# Thin wrapper (F10): Workers Logs + Logpush to R2 (30-day retention) and the PDPL export-bundle expiry (G7/G10) are set up by the script vendored from
# the foundation, scripts/foundation/logpush-setup.sh (tokens, idempotent verify-then-skip steps and the Workers list are documented there). Never edit
# that copy. Usage: bash scripts/ops/cf-logs-setup.sh  (same environment variables as before)
set -euo pipefail
exec bash "$(dirname "${BASH_SOURCE[0]}")/../foundation/logpush-setup.sh" "$@"
