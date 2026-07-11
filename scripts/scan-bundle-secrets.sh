#!/usr/bin/env bash
# scan-bundle-secrets.sh — client trust-boundary guard (Builder Reality Audit Lens K).
#
# "The frontend is a display layer, not a trust layer." gitleaks/trufflehog scan the
# REPO for committed secrets; this scans what actually reaches the BROWSER — client
# source (apps/{web,admin,orders}/src) and, when present, the built output — for
# high-signal secret material and server-only env references that must never ship.
#
# It does NOT flag intentionally-public values: NEXT_PUBLIC_* / VITE_* env vars, the
# VAPID *public* key, the Sentry DSN, the PostHog key — those are public by design.
# It targets things that are ALWAYS a leak: private keys, provider *secret* keys,
# credentialed DB URLs, and the names of server-only secrets appearing in client code.
#
# Usage:
#   scan-bundle-secrets.sh              # scan client source (default; CI on every PR)
#   scan-bundle-secrets.sh --build DIR  # also scan a built bundle dir (deploy-time belt)
# Exit 1 on any finding. Allowlist documented false positives in .bundle-scan-allow
# (one substring per line; a match containing an allowlisted substring is ignored).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ALLOW="$ROOT/.bundle-scan-allow"

BUILD_DIR=""
[ "${1:-}" = "--build" ] && BUILD_DIR="${2:-}"

# Client source roots (only what compiles into the browser bundle).
SRC_ROOTS=()
for d in apps/web/src apps/admin/src apps/orders/src; do
  [ -d "$ROOT/$d" ] && SRC_ROOTS+=("$ROOT/$d")
done

# High-signal secret patterns that must NEVER appear in client code / bundle.
# (ERE, one per entry — scanned individually so a tricky class can't break the set.)
PATTERNS=(
  '-----BEGIN [A-Z ]*PRIVATE KEY'                       # any private key block
  'sk_live_[0-9A-Za-z]{16,}'                            # Stripe live secret
  'sk_test_[0-9A-Za-z]{16,}'                            # Stripe test secret
  'AIza[0-9A-Za-z_-]{35}'                               # Google/Gemini API key
  'sk-[A-Za-z0-9]{32,}'                                 # OpenAI-style secret
  'postgres(ql)?://[^:@/[:space:]]+:[^@/[:space:]]+@'   # DB URL WITH credentials
  # server-only env ACCESS in client code (process.env.X, not doc strings/labels) —
  # Next strips non-NEXT_PUBLIC in the client, so this is a bug/leak-intent signal.
  'process\.env\.[A-Za-z_]*(JWT_SECRET|ENCRYPTION_KEY|VAPID_PRIVATE_KEY|SERVICE_ROLE|DIRECT_URL|DATABASE_URL|_REST_API_KEY|_SECRET_KEY|_PRIVATE_KEY)'
)

hits=0
scan_dir() {
  local dir="$1" label="$2" ext="$3" pat line
  [ -d "$dir" ] || return 0
  for pat in "${PATTERNS[@]}"; do
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      # allowlist filter (documented false positives)
      if [ -f "$ALLOW" ] && grep -Fq -f <(grep -vE '^\s*(#|$)' "$ALLOW") <<<"$line" 2>/dev/null; then continue; fi
      echo "  ✗ [$label] $line" | sed -E 's/([A-Za-z0-9_+-]{10})[A-Za-z0-9_+/=.-]{8,}/\1…REDACTED/g'
      hits=$((hits+1))
    done < <(grep -rEnI --include="$ext" "$pat" "$dir" 2>/dev/null | grep -vE 'NEXT_PUBLIC_|VITE_')
  done
}

echo "== client trust-boundary secret scan =="
for r in "${SRC_ROOTS[@]}"; do scan_dir "$r" "src:${r##*apps/}" '*.ts*'; done
if [ -n "$BUILD_DIR" ]; then
  echo "-- built bundle: $BUILD_DIR"
  scan_dir "$BUILD_DIR" "bundle" '*.js'
fi

if [ "$hits" -gt 0 ]; then
  echo
  echo "FAIL: $hits potential secret/server-only reference(s) reaching the browser."
  echo "The frontend is a display layer, not a trust layer — move secrets/logic server-side,"
  echo "or if a match is a documented false positive add its substring to .bundle-scan-allow."
  exit 1
fi
echo "OK: no client-side secret leakage detected."
