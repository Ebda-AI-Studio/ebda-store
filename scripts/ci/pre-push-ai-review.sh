#!/usr/bin/env bash
# Advisory AI review for .husky/pre-push. Usage: pre-push-ai-review.sh <git-range> <branch>
# - Reviews ONLY the range given (the commits being pushed: remote ref..HEAD), not the whole branch vs main.
# - Chunks the diff by file (sorted, so directory groups stay together) under AI_REVIEW_CHUNK_BYTES (default 60000) so a big
#   push no longer dies with "Prompt is too long".
# - Per chunk: opus if it touches a critical path, else sonnet (AI_REVIEW_MODEL=opus|sonnet forces one).
# - NEVER blocks the push (always exits 0), but never fails silently: any file that could not be reviewed is listed in a LOUD
#   warning and appended to <git-dir>/ai-review-unreviewed.log.
set -u
RANGE="${1:?range}"
BRANCH="${2:?branch}"
CAP="${AI_REVIEW_CHUNK_BYTES:-60000}"
CRITICAL_RE='(migrations/|payment|billing|wallet|refund|payout|webhook|auth|mfa|passkey|login|session|identity|encrypt|crypto|secret|consent|erasure|privacy|rls|tenant|cod-reconciliation|price|coupon|fiscal|tax|money|\.husky/|\.github/workflows/)'

if ! command -v claude >/dev/null 2>&1; then
  echo "! claude CLI not found; AI review SKIPPED for the whole push (npm i -g @anthropic-ai/claude-code)"
  exit 0
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
gitdir=$(git rev-parse --git-dir)
log="$gitdir/ai-review-unreviewed.log"
marker="$gitdir/.ai-review-$(printf '%s' "$BRANCH" | tr '/' '_')"
: > "$work/unreviewed"

git diff --name-only "$RANGE" -- ':(exclude)**/package-lock.json' ':(exclude)**/*.lock' 2>/dev/null | sort > "$work/files"
if [ ! -s "$work/files" ]; then
  echo "-> AI review: nothing to review in $RANGE"
  exit 0
fi

# Pack files into chunks: chunk.N.files + chunk.N.diff
n=0; size=0
: > "$work/chunk.0.files"; : > "$work/chunk.0.diff"
while IFS= read -r f; do
  git diff "$RANGE" -- "$f" > "$work/one.diff" 2>/dev/null || true
  [ -s "$work/one.diff" ] || continue
  osz=$(wc -c < "$work/one.diff" | tr -d ' ')
  if [ "$osz" -gt "$CAP" ]; then
    head -c "$CAP" "$work/one.diff" > "$work/trunc.diff"
    mv "$work/trunc.diff" "$work/one.diff"
    printf '%s (diff truncated at %s bytes: only the head was reviewed)\n' "$f" "$CAP" >> "$work/unreviewed"
    osz="$CAP"
  fi
  if [ "$size" -gt 0 ] && [ $((size + osz)) -gt "$CAP" ]; then
    n=$((n + 1)); size=0
    : > "$work/chunk.$n.files"; : > "$work/chunk.$n.diff"
  fi
  printf '%s\n' "$f" >> "$work/chunk.$n.files"
  cat "$work/one.diff" >> "$work/chunk.$n.diff"
  size=$((size + osz))
done < "$work/files"

total=$((n + 1))
echo "-> AI review: $(wc -l < "$work/files" | tr -d ' ') file(s) in $total chunk(s), range $RANGE"
i=0
while [ "$i" -le "$n" ]; do
  cf="$work/chunk.$i.files"; cd_="$work/chunk.$i.diff"
  if [ -s "$cd_" ]; then
    if [ -n "${AI_REVIEW_MODEL:-}" ]; then model="$AI_REVIEW_MODEL"
    elif grep -Eiq "$CRITICAL_RE" "$cf"; then model=opus
    else model=sonnet; fi
    hash=$(shasum -a 256 "$cd_" | cut -c1-16)
    if [ -f "$marker" ] && grep -qx "$hash" "$marker"; then
      echo "   chunk $((i + 1))/$total: identical diff already reviewed ($hash), skipped"
    else
      echo "   chunk $((i + 1))/$total: $model ($(wc -l < "$cf" | tr -d ' ') file(s))"
      { printf 'Review this diff for CRITICAL bugs, security issues, and regressions ONLY. Be terse; list nothing if clean.\n\n'; cat "$cd_"; } > "$work/prompt.md"
      if claude -p --model "$model" < "$work/prompt.md" > "$work/out.txt" 2> "$work/err.txt" && [ -s "$work/out.txt" ] \
        && ! grep -qiE 'prompt is too long|credit balance|rate limit|overloaded' "$work/out.txt"; then
        cat "$work/out.txt"
        printf '%s\n' "$hash" >> "$marker"
      else
        cat "$work/out.txt" "$work/err.txt" 2>/dev/null | head -5
        sed "s/\$/ (chunk $((i + 1))\/$total, $model: review failed)/" "$cf" >> "$work/unreviewed"
      fi
    fi
  fi
  i=$((i + 1))
done

if [ -s "$work/unreviewed" ]; then
  {
    echo "=== $(date -u +%FT%TZ) branch=$BRANCH range=$RANGE"
    cat "$work/unreviewed"
  } >> "$log"
  echo ""
  echo "############################################################"
  echo "!! AI REVIEW INCOMPLETE -- these files were NOT (fully) reviewed:"
  sed 's/^/!!   /' "$work/unreviewed"
  critical=$(grep -Ei "$CRITICAL_RE" "$work/unreviewed" || true)
  [ -n "$critical" ] && echo "!! CRITICAL-PATH files among them: review them by hand before merging."
  echo "!! logged to $log -- push proceeds (advisory gate)"
  echo "############################################################"
fi
exit 0
