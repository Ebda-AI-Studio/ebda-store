#!/usr/bin/env bash
# root-checkout-guard.sh <pre-commit|pre-merge-commit|post-merge> - standalone root-checkout guard (2026-11-23).
# Run it from inside the repo (a git hook's cwd already is). Called by the global dispatcher (git-hooks/dispatch.sh)
# AND by repos that set their own core.hooksPath (husky) and therefore never reach the global hooks: vendor this file
# and call it from .husky/pre-commit + .husky/pre-merge-commit.
#
# Defect class: `cd <worktree> && git merge ...` fails at the cd, git runs in the ROOT checkout
# (<projects>/<biz>/internal-projects/<repo> or <biz>/clients/<client>/<repo>), which must stay on main read-only, and
# local main moves ahead of origin.
# pre-commit / pre-merge-commit: exit 1 (message names new-task-worktree.sh) when ALL hold: MAIN worktree
#   (git-dir == git-common-dir), path in a business-folder slot under $OS_PROJECTS_DIR (default ~/Desktop/projects),
#   HEAD is main/master. Fast-forward merges run no pre-merge-commit and stay allowed.
# post-merge: WARNS (exit 0) when root main ended up not contained in origin/<branch>.
# Escape hatch: EBDA_ALLOW_ROOT_COMMIT=1 (each use logged to ~/Library/Logs/root-commit-guard.log).
# Never blocks on what it cannot see (not a repo, detached HEAD, path outside the slots).
set -uo pipefail
name="${1:-pre-commit}"

gd="$(git rev-parse --path-format=absolute --git-dir 2>/dev/null)" || exit 0
cdir="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || exit 0
[ -n "$gd" ] && [ "$(cd "$gd" 2>/dev/null && pwd -P)" = "$(cd "$cdir" 2>/dev/null && pwd -P)" ] || exit 0
top="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
[ -n "$top" ] || exit 0
top="$(cd "$top" 2>/dev/null && pwd -P)" || exit 0
proj="$(cd "${OS_PROJECTS_DIR:-$HOME/Desktop/projects}" 2>/dev/null && pwd -P)" || exit 0
case "$top" in
  "$proj"/*/internal-projects/*|"$proj"/*/clients/*/*) ;;
  *) exit 0 ;;
esac
br="$(git symbolic-ref --short -q HEAD 2>/dev/null)" || exit 0
case "$br" in main|master) ;; *) exit 0 ;; esac

case "$name" in
  pre-commit|pre-merge-commit)
    if [ "${EBDA_ALLOW_ROOT_COMMIT:-0}" = 1 ]; then
      mkdir -p "$HOME/Library/Logs" 2>/dev/null
      echo "$(date -u +%FT%TZ) $name ALLOWED via EBDA_ALLOW_ROOT_COMMIT=1 in $top ($br)" >> "$HOME/Library/Logs/root-commit-guard.log" 2>/dev/null || true
      exit 0
    fi
    {
      echo "root-checkout-guard: REFUSED $name in $top (main checkout on $br)."
      echo "  Root checkouts stay on main, read-only. Do the work in a worktree:"
      echo "    ~/.claude/scripts/new-task-worktree.sh <repo> <feat|fix>/<task>"
      echo "  (a failed \`cd <worktree> && git ...\` runs git HERE - check the cd succeeded.)"
      echo "  Deliberate override: EBDA_ALLOW_ROOT_COMMIT=1 git ... (logged)."
    } >&2
    exit 1 ;;
  post-merge)
    if [ "${EBDA_ALLOW_ROOT_COMMIT:-0}" != 1 ] \
       && git rev-parse -q --verify "refs/remotes/origin/$br" >/dev/null 2>&1 \
       && ! git merge-base --is-ancestor HEAD "refs/remotes/origin/$br" 2>/dev/null; then
      echo "root-checkout-guard: WARNING - local $br in $top is now AHEAD of origin/$br. Root must mirror origin: undo with \`git reset --hard origin/$br\` after checking nothing unique is on it, and redo the work in a worktree." >&2
    fi
    exit 0 ;;
esac
exit 0
