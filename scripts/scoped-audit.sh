#!/usr/bin/env bash
# Whisky AI OS — blast-radius-scoped PR audit input builder.
# Prepares a claude -p input file (prompt + changed files + dependents +
# active dimensions + unified diff) without invoking claude itself.
# The caller (workflow) invokes claude and passes the output to audit.mjs.
#
# Usage:
#   bash scripts/scoped-audit.sh <repo-slug> <base..head|pr-number> [repo-root]
#
# Env vars:
#   AUDIT_INPUT=<path>   path to write the claude input file (default /tmp/scoped-audit-input.md)
#   DRY_RUN=1            print actions, skip writing (safe for local testing)
#   BLAST_TOP_N=30       max dependents to include in input (default 30)
#
# Exit codes:
#   0 — input file written (or dry-run completed)
#   1 — fatal (missing required arg or tool)
set -uo pipefail

AUDIT_INPUT="${AUDIT_INPUT:-/tmp/scoped-audit-input.md}"
DRY_RUN="${DRY_RUN:-0}"
BLAST_TOP_N="${BLAST_TOP_N:-30}"

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
if [ "${#}" -lt 2 ]; then
  echo "usage: scoped-audit.sh <repo-slug> <base..head|pr-number> [repo-root]" >&2
  exit 1
fi
REPO_SLUG="$1"
PR_REF="$2"
REPO_ROOT="${3:-.}"

command -v python3 >/dev/null || { echo "scoped-audit: python3 missing" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Locate graphify-out/graph.json relative to repo root (or well-known paths)
# ---------------------------------------------------------------------------
GRAPH_JSON=""
if [ -f "$REPO_ROOT/graphify-out/graph.json" ]; then
  GRAPH_JSON="$REPO_ROOT/graphify-out/graph.json"
else
  # Fallback: search worktrees
  _wt_graph=$(find "$HOME/Desktop/projects/_worktrees" -maxdepth 3 \
    -name "graph.json" -path "*/graphify-out/*" 2>/dev/null \
    | grep "$REPO_SLUG" | head -1)
  if [ -n "$_wt_graph" ]; then
    GRAPH_JSON="$_wt_graph"
  else
    # Search well-known project roots
    for _p in \
      "$HOME/Desktop/projects/Ebda-AI-Studio/internal-projects/ebda-store"; do
      if [[ "$_p" == *"$REPO_SLUG"* ]] && [ -f "$_p/graphify-out/graph.json" ]; then
        GRAPH_JSON="$_p/graphify-out/graph.json"
        break
      fi
    done
  fi
fi

# ---------------------------------------------------------------------------
# Fetch changed files (bash 3.2 compatible — no mapfile)
# ---------------------------------------------------------------------------
_read_lines_into_array() {
  local _arr_name="$1"; shift
  local _line
  while IFS= read -r _line; do
    eval "${_arr_name}+=(\"\$_line\")"
  done < <("$@")
}

_is_pr_number() { [[ "$1" =~ ^[0-9]+$ ]]; }

CHANGED_FILES=()
if _is_pr_number "$PR_REF"; then
  command -v gh >/dev/null || { echo "scoped-audit: gh CLI missing (needed for PR lookup)" >&2; exit 1; }
  GH_USER="${GH_USER:-Ebda-AI-Studio}"
  _read_lines_into_array CHANGED_FILES \
    gh pr diff --repo "$GH_USER/$REPO_SLUG" "$PR_REF" --name-only
else
  # ref range: "base..head" or "base...head" — pass PR_REF straight through
  # to git as ONE argument (#1763). Splitting it on `..` into two separate
  # positional refs and handing them to `git diff A B` always computes a
  # direct two-commit diff, collapsing three-dot (merge-base) semantics to
  # two-dot ones: a branch that is merely BEHIND main then presents as having
  # REVERTED everything main gained since the branch point, inviting P0/P1
  # findings on code the branch never touched. git's own range parser already
  # handles both "A..B" and "A...B" correctly when given as a single string —
  # a bare ref with no ".." at all (no PR range, just one SHA) is unaffected
  # either way, so no branch is needed here.
  _read_lines_into_array CHANGED_FILES \
    git -C "$REPO_ROOT" diff --name-only "$PR_REF"
fi

# bash 3.2 unbound-variable guard: guard before any ${arr[@]} expansion
if [ "${#CHANGED_FILES[@]}" -eq 0 ]; then
  echo "scoped-audit: no changed files for $PR_REF — nothing to audit"
  exit 0
fi

# Filter noise (lock files, generated files, dist, .next)
NOISE_PATTERN='(^node_modules($|/)|\.lock$|package-lock\.json$|yarn\.lock$|pnpm-lock\.yaml$|\.min\.js$|/\.next/|/dist/|/build/|graphify-out/)'
FILTERED_FILES=()
for _f in "${CHANGED_FILES[@]}"; do
  if ! echo "$_f" | grep -qE "$NOISE_PATTERN"; then
    FILTERED_FILES+=("$_f")
  fi
done
# Re-guard after noise filter (bash 3.2 unbound-safe)
CHANGED_FILES=(${FILTERED_FILES[@]+"${FILTERED_FILES[@]}"})

if [ "${#CHANGED_FILES[@]}" -eq 0 ]; then
  echo "scoped-audit: only noise-filtered files changed — skipping audit"
  exit 0
fi

echo "scoped-audit: ${#CHANGED_FILES[@]} changed source file(s):"
printf '  %s\n' "${CHANGED_FILES[@]}"

# ---------------------------------------------------------------------------
# Compute transitive dependents via graphify graph (python3 -c, same approach
# as blast-radius.sh so the graph traversal logic stays in sync)
# ---------------------------------------------------------------------------
CHANGED_JSON="$(python3 -c "import json,sys; print(json.dumps(sys.argv[1:]))" \
  "${CHANGED_FILES[@]}")"

_PY_DEPENDENTS='
import sys, json, collections

changed_files = json.loads(sys.argv[1])
top_n         = int(sys.argv[2])
graph_path    = sys.argv[3]

try:
    with open(graph_path) as f:
        g = json.load(f)
except Exception as e:
    print(json.dumps({"error": str(e), "dependents": [], "max_blast": []}))
    sys.exit(0)

nodes = g.get("nodes", [])
links = g.get("links", [])

id_to_file   = {}
file_to_ids  = collections.defaultdict(list)
for n in nodes:
    nid = n.get("id") or ""
    sf  = n.get("source_file") or ""
    if nid and sf:
        id_to_file[nid] = sf
        file_to_ids[sf].append(nid)

DEPEND_RELS = {"imports_from", "imports", "calls", "references"}
rev_adj = collections.defaultdict(set)
for l in links:
    if l.get("relation") in DEPEND_RELS:
        src = l.get("source") or ""
        tgt = l.get("target") or ""
        if src and tgt:
            rev_adj[tgt].add(src)

changed_node_ids = set()
for cf in changed_files:
    for nid in file_to_ids.get(cf, []):
        changed_node_ids.add(nid)

def transitive_dependents(seed_ids):
    visited = set()
    queue   = collections.deque(seed_ids)
    while queue:
        nid = queue.popleft()
        if nid in visited:
            continue
        visited.add(nid)
        for dep_id in rev_adj.get(nid, []):
            if dep_id not in visited:
                queue.append(dep_id)
    return visited

all_dep_ids   = transitive_dependents(changed_node_ids)
changed_set   = set(changed_files)
dep_score     = collections.Counter()
for nid in all_dep_ids:
    sf = id_to_file.get(nid)
    if sf and sf not in changed_set:
        dep_score[sf] += 1

top_files = [f for f, _ in dep_score.most_common(top_n)]

MAX_BLAST_PREFIXES = ("packages/shared", "packages/database")
max_blast = [cf for cf in changed_files if any(cf.startswith(p) for p in MAX_BLAST_PREFIXES)]

print(json.dumps({
    "dependents":  top_files,
    "total":       len(dep_score),
    "max_blast":   max_blast,
}))
'

DEPENDENTS_JSON=""
DEPENDENT_FILES=()
MAX_BLAST_FILES=()

if [ -n "$GRAPH_JSON" ] && [ -f "$GRAPH_JSON" ]; then
  _result=$(python3 -c "$_PY_DEPENDENTS" \
    "$CHANGED_JSON" "$BLAST_TOP_N" "$GRAPH_JSON" 2>/dev/null)
  if [ -n "$_result" ]; then
    DEPENDENTS_JSON="$_result"
    # Extract dependent file list and max_blast (bash 3.2 safe: use python to parse)
    _dep_list=$(python3 -c "
import json,sys
r = json.loads(sys.argv[1])
for f in r.get('dependents',[]): print(f)
" "$DEPENDENTS_JSON" 2>/dev/null)
    while IFS= read -r _line; do
      [ -n "$_line" ] && DEPENDENT_FILES+=("$_line")
    done <<< "$_dep_list"

    _blast_list=$(python3 -c "
import json,sys
r = json.loads(sys.argv[1])
for f in r.get('max_blast',[]): print(f)
" "$DEPENDENTS_JSON" 2>/dev/null)
    while IFS= read -r _line; do
      [ -n "$_line" ] && MAX_BLAST_FILES+=("$_line")
    done <<< "$_blast_list"
  fi
else
  echo "scoped-audit: graphify-out/graph.json not found — blast-radius dependents skipped"
fi

echo ""
if [ "${#DEPENDENT_FILES[@]}" -gt 0 ]; then
  echo "scoped-audit: ${#DEPENDENT_FILES[@]} transitive dependent(s) (top $BLAST_TOP_N):"
  printf '  %s\n' "${DEPENDENT_FILES[@]}"
else
  echo "scoped-audit: no transitive dependents found (change appears self-contained)"
fi

# ---------------------------------------------------------------------------
# Map changed + dependent files → active DIMENSIONS
# (table from audit-gating.md §"Per-PR scoping")
# ---------------------------------------------------------------------------
_has_path_matching() {
  # _has_path_matching <pattern> file1 file2 ...
  # Returns 0 (true) if any file in the list matches the grep pattern.
  local _pattern="$1"; shift
  for _file in "$@"; do
    echo "$_file" | grep -qiE "$_pattern" && return 0
  done
  return 1
}

# Combine changed + dependent for dimension mapping
ALL_FILES=()
ALL_FILES+=("${CHANGED_FILES[@]}")
# bash 3.2: only expand if non-empty
ALL_FILES+=(${DEPENDENT_FILES[@]+"${DEPENDENT_FILES[@]}"})

# Dedup (bash 3.2 compat — use python3)
ALL_FILES_JSON="$(python3 -c "import json,sys; print(json.dumps(list(dict.fromkeys(sys.argv[1:]))))" \
  "${ALL_FILES[@]}")"

DIMS=()

# payment / order / checkout / money
if _has_path_matching '(payment|order|checkout|money|invoice|billing|cart)' "${ALL_FILES[@]}"; then
  DIMS+=("money")
  DIMS+=("rls")
  DIMS+=("contract-drift")
  DIMS+=("reliability")
  DIMS+=("security")
fi

# API routes / middleware / services
if _has_path_matching 'apps/api/.*(routes|middleware|service)' "${ALL_FILES[@]}"; then
  _added_security=0
  _added_contract=0
  _added_rls=0
  _added_scaling=0
  for _d in ${DIMS[@]+"${DIMS[@]}"}; do
    [ "$_d" = "security" ]       && _added_security=1
    [ "$_d" = "contract-drift" ] && _added_contract=1
    [ "$_d" = "rls" ]            && _added_rls=1
    [ "$_d" = "scaling" ]        && _added_scaling=1
  done
  [ "$_added_security" = "0" ]  && DIMS+=("security")
  [ "$_added_contract" = "0" ]  && DIMS+=("contract-drift")
  [ "$_added_rls" = "0" ]       && DIMS+=("rls")
  [ "$_added_scaling" = "0" ]   && DIMS+=("scaling")
fi

# packages/database, prisma, migrations
if _has_path_matching '(packages/database|prisma|migration)' "${ALL_FILES[@]}"; then
  _added_rls=0; _added_contract=0; _added_scaling=0; _added_data_ui=0
  for _d in ${DIMS[@]+"${DIMS[@]}"}; do
    [ "$_d" = "rls" ]           && _added_rls=1
    [ "$_d" = "contract-drift" ] && _added_contract=1
    [ "$_d" = "scaling" ]       && _added_scaling=1
    [ "$_d" = "data-ui" ]       && _added_data_ui=1
  done
  [ "$_added_rls" = "0" ]       && DIMS+=("rls")
  [ "$_added_contract" = "0" ]  && DIMS+=("contract-drift")
  [ "$_added_scaling" = "0" ]   && DIMS+=("scaling")
  [ "$_added_data_ui" = "0" ]   && DIMS+=("data-ui")
fi

# packages/shared — kernel, max blast radius
if _has_path_matching 'packages/shared' "${CHANGED_FILES[@]}"; then
  # All application dimensions since the shared kernel ripples everywhere
  for _d in "contract-drift" "rls" "security" "scaling" "money" "reliability" "idempotency" "data-ui"; do
    _found=0
    for _existing in ${DIMS[@]+"${DIMS[@]}"}; do
      [ "$_existing" = "$_d" ] && _found=1 && break
    done
    [ "$_found" = "0" ] && DIMS+=("$_d")
  done
fi

# apps/web, apps/admin components (UI)
if _has_path_matching '(apps/web|apps/admin)' "${ALL_FILES[@]}"; then
  _added_uiux=0; _added_a11y=0; _added_contract=0
  for _d in ${DIMS[@]+"${DIMS[@]}"}; do
    [ "$_d" = "ui-ux" ]          && _added_uiux=1
    [ "$_d" = "a11y" ]           && _added_a11y=1
    [ "$_d" = "contract-drift" ] && _added_contract=1
  done
  [ "$_added_uiux" = "0" ]     && DIMS+=("ui-ux")
  [ "$_added_a11y" = "0" ]     && DIMS+=("a11y")
  [ "$_added_contract" = "0" ] && DIMS+=("contract-drift")
fi

# webhook / worker / cron / inngest (async writers)
if _has_path_matching '(webhook|worker|cron|inngest|queue|job)' "${ALL_FILES[@]}"; then
  _added_rls=0; _added_rel=0; _added_idem=0
  for _d in ${DIMS[@]+"${DIMS[@]}"}; do
    [ "$_d" = "rls" ]         && _added_rls=1
    [ "$_d" = "reliability" ] && _added_rel=1
    [ "$_d" = "idempotency" ] && _added_idem=1
  done
  [ "$_added_rls" = "0" ]   && DIMS+=("rls")
  [ "$_added_rel" = "0" ]   && DIMS+=("reliability")
  [ "$_added_idem" = "0" ]  && DIMS+=("idempotency")
fi

# .github / ops / scripts / docs-only changes
if _has_path_matching '(\.github/|scripts/|docs/|ops/)' "${ALL_FILES[@]}" && \
   ! _has_path_matching '(apps/|packages/)' "${CHANGED_FILES[@]}"; then
  DIMS+=("docs-parity")
fi

# Always include docs-parity if docs changed alongside code
if _has_path_matching '(\.md$|docs/)' "${ALL_FILES[@]}"; then
  _added=0
  for _d in ${DIMS[@]+"${DIMS[@]}"}; do [ "$_d" = "docs-parity" ] && _added=1 && break; done
  [ "$_added" = "0" ] && DIMS+=("docs-parity")
fi

# Fallback: if no dimension matched yet, run the universal core set
if [ "${#DIMS[@]}" -eq 0 ]; then
  DIMS+=("security" "contract-drift" "rls")
fi

# Dedup dimensions (bash 3.2 compat — guard empty array under set -u)
DIMS_JSON="$(python3 -c "import json,sys; print(json.dumps(list(dict.fromkeys(sys.argv[1:]))))" \
  ${DIMS[@]+"${DIMS[@]}"})"
DIMS_STR="$(python3 -c "import json,sys; print(', '.join(json.loads(sys.argv[1])))" "$DIMS_JSON")"

echo ""
echo "scoped-audit: active dimensions: $DIMS_STR"

# ---------------------------------------------------------------------------
# Build unified diff (cap at ~150 KB on a newline boundary, same as ai-review)
# ---------------------------------------------------------------------------
echo ""
echo "scoped-audit: building diff..."
DIFF_CONTENT=""
if [[ "$PR_REF" == *..* ]]; then
  # Same fix as the changed-file list above (#1763): PR_REF passed through as
  # ONE argument, not split into two positional refs, so three-dot
  # (merge-base) semantics survive instead of silently degrading to a direct
  # two-commit diff.
  DIFF_CONTENT=$(git -C "$REPO_ROOT" diff "$PR_REF" -- . \
    ':(exclude)**/package-lock.json' ':(exclude)**/*.lock' \
    ':(exclude)**/dist/**' ':(exclude)**/.next/**' ':(exclude)**/*.snap' \
    | python3 -c "
import sys
d = sys.stdin.buffer.read(153600)
i = d.rfind(b'\n')
sys.stdout.buffer.write(d if i < 0 else d[:i+1])
" 2>/dev/null)
elif _is_pr_number "$PR_REF"; then
  command -v gh >/dev/null && \
    DIFF_CONTENT=$(gh pr diff "$PR_REF" --repo "${GH_USER:-Ebda-AI-Studio}/$REPO_SLUG" 2>/dev/null \
    | python3 -c "
import sys
d = sys.stdin.buffer.read(153600)
i = d.rfind(b'\n')
sys.stdout.buffer.write(d if i < 0 else d[:i+1])
" 2>/dev/null)
else
  DIFF_CONTENT=$(git -C "$REPO_ROOT" diff "$PR_REF" -- . \
    | python3 -c "
import sys
d = sys.stdin.buffer.read(153600)
i = d.rfind(b'\n')
sys.stdout.buffer.write(d if i < 0 else d[:i+1])
" 2>/dev/null)
fi

DIFF_LINES=$(echo "$DIFF_CONTENT" | wc -l | tr -d ' ')
echo "scoped-audit: diff captured (~${DIFF_LINES} lines)"

# ---------------------------------------------------------------------------
# Write the claude -p input file
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROMPT_FILE="$SCRIPT_DIR/../.github/scoped-audit/prompt.md"

# Locate prompt relative to the worktree root (CI runs from repo root)
if [ ! -f "$PROMPT_FILE" ]; then
  PROMPT_FILE=".github/scoped-audit/prompt.md"
fi

if [ ! -f "$PROMPT_FILE" ]; then
  echo "scoped-audit: prompt.md not found at $PROMPT_FILE" >&2
  exit 1
fi

if [ "${DRY_RUN}" = "1" ]; then
  echo ""
  echo "[DRY_RUN] Would write input to: $AUDIT_INPUT"
  echo "[DRY_RUN] Dimensions: $DIMS_STR"
  echo "[DRY_RUN] Changed files: ${CHANGED_FILES[*]}"
  echo "[DRY_RUN] Dependents (top ${#DEPENDENT_FILES[@]}): ${DEPENDENT_FILES[*]+"${DEPENDENT_FILES[*]}"}"
  exit 0
fi

{
  cat "$PROMPT_FILE"
  echo ""
  echo "---"
  echo ""
  echo "## CHANGED FILES"
  echo ""
  for _f in "${CHANGED_FILES[@]}"; do echo "- $_f"; done
  echo ""
  echo "## BLAST-RADIUS DEPENDENTS"
  echo ""
  if [ "${#MAX_BLAST_FILES[@]}" -gt 0 ]; then
    echo "> **MAX BLAST RADIUS**: the following changed files are in packages/shared or"
    echo "> packages/database and ripple to ALL consumers across every app:"
    for _f in "${MAX_BLAST_FILES[@]}"; do echo "> - $_f"; done
    echo ""
  fi
  if [ "${#DEPENDENT_FILES[@]}" -gt 0 ]; then
    for _f in "${DEPENDENT_FILES[@]}"; do echo "- $_f"; done
  else
    echo "_No transitive dependents found (change appears self-contained)._"
  fi
  echo ""
  echo "## ACTIVE DIMENSIONS"
  echo ""
  echo "$DIMS_STR"
  echo ""
  echo "## UNIFIED DIFF"
  echo ""
  echo "Review per the instructions above and respond with ONLY the JSON object."
  echo ""
  printf '%s' "$DIFF_CONTENT"
} > "$AUDIT_INPUT"

echo ""
echo "scoped-audit: input written to $AUDIT_INPUT"
echo "scoped-audit: dimensions=$DIMS_STR"
