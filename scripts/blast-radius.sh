#!/usr/bin/env bash
# Whisky AI OS — blast-radius PR reviewer (graphify-driven).
# Read-only. Given a repo slug + PR number (or base..head ref), it:
#   1. Fetches the changed files via `gh pr diff --name-only` (PR-number mode) or `git diff`
#      (base..head ref mode, which CI uses and which needs NO gh CLI).
#   2. Locates the repo's graphify-out/graph.json.
#   3. Parses the graph (python3 -c) to find, for every changed file, all transitive
#      DEPENDENTS (files that import / call / reference the changed file, directly or
#      through intermediaries).
#   4. Flags MAXIMUM blast radius when changed files are in packages/shared or
#      packages/database (they ripple to all consumers across every app).
#   5. Outputs a concise report and fires ONE Telegram message via notify.sh.
#
# Never mutates the target repo. Degrades gracefully when graphify-out/ is absent.
#
# Usage:
#   ops/blast-radius.sh <repo-slug> <pr-number>           # PR-based (standard)
#   ops/blast-radius.sh <repo-slug> <base>..<head> [path] # ref-based (CI); path= repo root
#
# Options / env vars:
#   DRY_RUN=1            — print Telegram message instead of sending it (safe for testing)
#   GRAPH_ROOT=<path>    — override root where graphify-out/ is found (default: auto-detect)
#   BLAST_TOP_N=20       — max dependent files shown in report (default 20)
#   GH_USER=Ebda-AI-Studio    — GitHub username/org owning the repos
#
# Exit codes:
#   0 — ran successfully (even if zero dependents found)
#   1 — fatal: missing required tool (gh, python3) or bad arguments
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
NOTIFY="$HERE/notify.sh"
GH_USER="${GH_USER:-Ebda-AI-Studio}"
BLAST_TOP_N="${BLAST_TOP_N:-20}"
DRY_RUN="${DRY_RUN:-0}"

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
if [ "${#}" -lt 2 ]; then
  echo "usage: blast-radius.sh <repo-slug> <pr-number|base..head> [repo-root-path]" >&2
  exit 1
fi
REPO_SLUG="$1"
PR_REF="$2"
REPO_ROOT_OVERRIDE="${3:-}"

# ---------------------------------------------------------------------------
# Tool checks
# ---------------------------------------------------------------------------
command -v python3 >/dev/null || { echo "blast-radius: python3 missing" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Locate the repo root (for graph.json lookup)
# ---------------------------------------------------------------------------
KNOWN_ROOTS=(
  "$HOME/Desktop/projects/Ebda-AI-Studio/internal-projects/ebda-store"
)

find_graph_json() {
  # Priority: 1) explicit override  2) well-known paths  3) worktrees
  local slug="$1"
  if [ -n "$REPO_ROOT_OVERRIDE" ]; then
    echo "$REPO_ROOT_OVERRIDE/graphify-out/graph.json"
    return
  fi
  for p in "${KNOWN_ROOTS[@]}"; do
    if [[ "$p" == *"$slug"* ]] && [ -f "$p/graphify-out/graph.json" ]; then
      echo "$p/graphify-out/graph.json"
      return
    fi
  done
  # Fallback: search worktrees dir
  local wt_graph
  wt_graph=$(find "$HOME/Desktop/projects/_worktrees" -maxdepth 2 \
    -name "graph.json" -path "*/graphify-out/*" 2>/dev/null \
    | grep "$slug" | head -1)
  if [ -n "$wt_graph" ]; then
    echo "$wt_graph"
    return
  fi
  echo ""
}

GRAPH_JSON="${GRAPH_ROOT:-$(find_graph_json "$REPO_SLUG")}"

if [ -z "$GRAPH_JSON" ] || [ ! -f "$GRAPH_JSON" ]; then
  echo "blast-radius: graphify-out/graph.json not found for $REPO_SLUG — skipping blast-radius analysis (run 'graphify .' in the repo first)" >&2
  exit 0
fi

# ---------------------------------------------------------------------------
# Fetch changed files
# ---------------------------------------------------------------------------
is_pr_number() { [[ "$1" =~ ^[0-9]+$ ]]; }

CHANGED_FILES=()
# bash 3.2 (macOS default) lacks mapfile — use a while-read loop compatible with bash ≥3.2
_read_lines_into_array() {
  local _arr_name="$1"; shift
  local _line
  while IFS= read -r _line; do
    eval "${_arr_name}+=(\"\$_line\")"
  done < <("$@")
}

if is_pr_number "$PR_REF"; then
  command -v gh >/dev/null || { echo "blast-radius: gh CLI missing (needed for PR lookup)" >&2; exit 1; }
  PR_NUMBER="$PR_REF"
  PR_LABEL="$REPO_SLUG#$PR_NUMBER"
  _read_lines_into_array CHANGED_FILES \
    gh pr diff --repo "$GH_USER/$REPO_SLUG" "$PR_NUMBER" --name-only
else
  # base..head ref — diff LOCALLY (works for unpushed branches + in CI with
  # fetch-depth:0). Accepts "base..head", "base...head", or a single ref.
  PR_LABEL="$REPO_SLUG@$PR_REF"
  _diff_root="${REPO_ROOT_OVERRIDE:-.}"
  # PR_REF goes to git as ONE argument (issue 2338, same class as #1763 in
  # scoped-audit.sh): splitting "base...head" on `..` into two positional refs
  # collapsed three-dot (merge-base) semantics to a direct two-commit diff, so
  # a PR merely BEHIND main reported every main-only file as its own change.
  _read_lines_into_array CHANGED_FILES \
    git -C "$_diff_root" diff --name-only "$PR_REF"
fi

# bash 3.2 (macOS) errors on "${arr[@]}" when arr is empty under `set -u`.
# Guard BEFORE any value-expansion so an all-noise / empty diff exits cleanly
# instead of crashing with "unbound variable".
if [ "${#CHANGED_FILES[@]}" -eq 0 ]; then
  echo "blast-radius: no changed files for $PR_LABEL — nothing to analyse"
  exit 0
fi

# Filter noise: skip node_modules, lock files, generated files, and pure docs
# (they can't be importers/importees in the source graph).
NOISE_PATTERN='(^node_modules($|/)|\.lock$|package-lock\.json$|yarn\.lock$|pnpm-lock\.yaml$|\.min\.js$|/\.next/|/dist/|/build/|graphify-out/)'
FILTERED_FILES=()
for f in "${CHANGED_FILES[@]}"; do
  if ! echo "$f" | grep -qE "$NOISE_PATTERN"; then
    FILTERED_FILES+=("$f")
  fi
done
# Re-empty-guard: all changed files may have been noise (bash 3.2 unbound-safe).
CHANGED_FILES=(${FILTERED_FILES[@]+"${FILTERED_FILES[@]}"})

if [ "${#CHANGED_FILES[@]}" -eq 0 ]; then
  echo "blast-radius: no changed source files found for $PR_LABEL (all noise-filtered) — nothing to analyse"
  exit 0
fi

echo "blast-radius: $PR_LABEL — ${#CHANGED_FILES[@]} changed file(s)"
printf '  + %s\n' "${CHANGED_FILES[@]}"

# ---------------------------------------------------------------------------
# Python: parse graph and compute transitive dependents
# ---------------------------------------------------------------------------
# NOTE: the program MUST come from -c, never a heredoc — a heredoc and the gh
# pipe both target stdin and the heredoc wins, leaving json.load(stdin) empty.
# CHANGED_JSON is passed as argv[1]; TOP_N as argv[2]; graph path as argv[3].

CHANGED_JSON="$(python3 -c "import json,sys; print(json.dumps(sys.argv[1:]))" \
  "${CHANGED_FILES[@]}")"

_PY_BLAST_RADIUS='
import sys, json, collections

changed_files  = json.loads(sys.argv[1])   # list of changed file paths
top_n          = int(sys.argv[2])
graph_path     = sys.argv[3]

try:
    with open(graph_path) as f:
        g = json.load(f)
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(0)

nodes = g.get("nodes", [])
links = g.get("links", [])

# Build bidirectional maps: node_id <-> source_file
id_to_file = {}
file_to_ids = collections.defaultdict(list)
for n in nodes:
    nid  = n.get("id") or ""
    sf   = n.get("source_file") or ""
    if nid and sf:
        id_to_file[nid] = sf
        file_to_ids[sf].append(nid)

# Dependency relations: A depends_on B  means A -> B in the link
# For blast-radius we want to know: who depends ON our changed file?
# i.e., find all nodes whose source is *not* in changed files but whose target
# (directly or transitively) resolves to a changed file.
DEPEND_RELS = {"imports_from", "imports", "calls", "references"}

# Build adjacency: target_id -> [source_id, ...] (reverse edges = "who depends on me?")
rev_adj = collections.defaultdict(set)
for l in links:
    if l.get("relation") in DEPEND_RELS:
        src = l.get("source") or ""
        tgt = l.get("target") or ""
        if src and tgt:
            rev_adj[tgt].add(src)

# Collect all node IDs that belong to changed files
changed_node_ids = set()
for cf in changed_files:
    for nid in file_to_ids.get(cf, []):
        changed_node_ids.add(nid)

# BFS / iterative DFS for transitive dependents
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

all_dependent_ids = transitive_dependents(changed_node_ids)

# Map dependent node IDs back to source files (exclude the changed files themselves)
changed_file_set = set(changed_files)
dependent_files  = set()
for nid in all_dependent_ids:
    sf = id_to_file.get(nid)
    if sf and sf not in changed_file_set:
        dependent_files.add(sf)

# Score by how many unique nodes reference each dependent file (higher = more coupled)
dep_score = collections.Counter()
for nid in all_dependent_ids:
    sf = id_to_file.get(nid)
    if sf and sf not in changed_file_set:
        dep_score[sf] += 1

top_files = [f for f, _ in dep_score.most_common(top_n)]

# Identify maximum-blast packages
MAX_BLAST_PREFIXES = ("packages/shared", "packages/database")
max_blast_triggers = [cf for cf in changed_files
                      if any(cf.startswith(p) for p in MAX_BLAST_PREFIXES)]

print(json.dumps({
    "changed":          changed_files,
    "changed_node_ids": len(changed_node_ids),
    "total_dependents": len(dependent_files),
    "top_files":        top_files,
    "dep_scores":       {f: dep_score[f] for f in top_files},
    "max_blast":        max_blast_triggers,
}))
'

RESULT=$(python3 -c "$_PY_BLAST_RADIUS" \
  "$CHANGED_JSON" \
  "$BLAST_TOP_N" \
  "$GRAPH_JSON" 2>/dev/null)

if [ -z "$RESULT" ]; then
  echo "blast-radius: python analysis produced no output — graph may be malformed" >&2
  exit 0
fi

# ---------------------------------------------------------------------------
# Parse result and build report
# ---------------------------------------------------------------------------
_PY_REPORT='
import sys, json

res = json.loads(sys.argv[1])
label = sys.argv[2]

if "error" in res:
    print("ERROR parsing graph: " + res["error"])
    sys.exit(0)

changed        = res["changed"]
total_dep      = res["total_dependents"]
top_files      = res["top_files"]
dep_scores     = res["dep_scores"]
max_blast      = res["max_blast"]
changed_count  = len(changed)

# Risk level
if max_blast:
    risk = "MAXIMUM"
elif total_dep == 0:
    risk = "NONE"
elif total_dep <= 5:
    risk = "LOW"
elif total_dep <= 20:
    risk = "MEDIUM"
elif total_dep <= 60:
    risk = "HIGH"
else:
    risk = "MAXIMUM"

lines = []
lines.append("Blast-radius — %s" % label)
lines.append("Changed: %d file(s), Dependents: %d, Risk: %s" % (changed_count, total_dep, risk))

if max_blast:
    lines.append("MAX BLAST: change touches %s (ripples to ALL consumers)" %
                 ", ".join(max_blast))

if top_files:
    lines.append("Top %d most-coupled dependents:" % len(top_files))
    for f in top_files:
        lines.append("  [%d] %s" % (dep_scores.get(f,0), f))
elif total_dep == 0:
    lines.append("No dependents found — change appears self-contained.")

# One-line telegram summary (short)
tg = "Blast-radius for %s: %d changed -> %d dependents; risk=%s" % (
    label, changed_count, total_dep, risk)
if top_files:
    tg += "; check: " + ", ".join(top_files[:3])
    if len(top_files) > 3:
        tg += " (+%d more)" % (len(top_files)-3)

print(json.dumps({"report": "\n".join(lines), "tg_summary": tg, "risk": risk}))
'

REPORT_JSON=$(python3 -c "$_PY_REPORT" "$RESULT" "$PR_LABEL" 2>/dev/null)
REPORT=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['report'])" "$REPORT_JSON" 2>/dev/null)
TG_SUMMARY=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['tg_summary'])" "$REPORT_JSON" 2>/dev/null)
RISK=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['risk'])" "$REPORT_JSON" 2>/dev/null)

echo ""
echo "=== Blast-Radius Report ==="
echo "$REPORT"
echo "==========================="

# ---------------------------------------------------------------------------
# Notify (or dry-run)
# ---------------------------------------------------------------------------
# Only notify for non-trivial findings (risk > NONE) to avoid alert fatigue.
# Always notify for MAXIMUM risk regardless.
should_notify() {
  case "$RISK" in
    NONE) return 1 ;;
    *)    return 0 ;;
  esac
}

if should_notify; then
  if [ "${DRY_RUN}" = "1" ]; then
    echo ""
    echo "[DRY_RUN] Would send Telegram: $TG_SUMMARY"
  elif [ -x "$NOTIFY" ]; then
    printf '%s' "$TG_SUMMARY" | "$NOTIFY" "Blast-Radius" >/dev/null 2>&1 || \
      echo "blast-radius: notify.sh call failed (check Telegram creds)" >&2
  else
    echo "blast-radius: notify.sh not found/executable — skipping Telegram alert" >&2
  fi
fi

exit 0
