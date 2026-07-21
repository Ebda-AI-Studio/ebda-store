#!/usr/bin/env bash
# ============================================================
# OBSOLETE - DO NOT RUN.
# The Windows/WSL2 runners this script manages were ALL deleted.
# Every repo now runs CI on umbra guests (fwb-ci5-*).
# Verified 2026-07-21: gh api repos/ForceAI-KW/<repo>/actions/runners
# See wsl-runner-maintenance.md for the current runner table.
# ============================================================
# setup-parallel-runners.sh — N self-hosted runners per repo for parallel CI.
# RAM REALITY: ~11 GiB VM (not 16). Heaviest job ~5.4 GiB. So runner #1/repo keeps
# 8G/10G; extras get 3G/6G/2-core; DEFAULT 2/repo (3x3=9 would thrash). Run in WSL.
#   bash setup-parallel-runners.sh            # ensure 2/repo
#   RUNNERS_PER_REPO=3 bash ...               # watch free -h
#   ONLY_REPO=whatsapp-broadcaster bash ...
#   bash setup-parallel-runners.sh --list | --remove
# Auth: gh authed in WSL, or export GH_PAT=<repo+workflow PAT>.
set -uo pipefail
RUNNERS_PER_REPO="${RUNNERS_PER_REPO:-2}"
RUNNER_HOME="$HOME/runners"; TARBALL="$RUNNER_HOME/runner.tar.gz"
WATCHDOG="/usr/local/bin/runner-watchdog.sh"; SVC_USER="$(whoami)"
REPOS=(
  "fwb|ForceAI-KW/force-website-builder|windows-wsl-fwb"
  "wbs|ForceAI-KW/whatsapp-broadcaster|windows-wsl-wbs"
  "crm|ForceAI-KW/Force-Media-CRM|windows-wsl-crm"
)
log(){ printf '\033[36m[par-runners]\033[0m %s\n' "$*"; }
warn(){ printf '\033[33m[par-runners]\033[0m %s\n' "$*"; }
die(){ printf '\033[31m[par-runners] %s\033[0m\n' "$*" >&2; exit 1; }
gh_(){ if [ -n "${GH_PAT:-}" ]; then GH_TOKEN="$GH_PAT" gh "$@"; else gh "$@"; fi; }
reg_token(){ gh_ api -X POST "repos/$1/actions/runners/registration-token" --jq '.token'; }
rm_token(){ gh_ api -X POST "repos/$1/actions/runners/remove-token" --jq '.token'; }
svc_name(){ echo "actions.runner.${1//\//-}.$2"; }
filter_repos(){ for e in "${REPOS[@]}"; do IFS='|' read -r k s b <<<"$e"
  if [ -n "${ONLY_REPO:-}" ] && [ "$ONLY_REPO" != "$s" ] && [ "$ONLY_REPO" != "${s#*/}" ]; then continue; fi; echo "$e"; done; }
cmd_list(){ for e in $(filter_repos); do IFS='|' read -r k s b <<<"$e"; echo "=== $s ==="
    gh_ api "repos/$s/actions/runners" --jq '.runners[] | "  \(.name)  status=\(.status) busy=\(.busy)"' 2>&1; done
  echo "=== systemd ==="; systemctl list-units 'actions.runner.*' --all --no-pager --plain 2>/dev/null | awk '/actions\.runner/{print "  "$1"  "$3"/"$4}'; }
write_dropins(){ local svc="$1" mh="$2" mm="$3" cpu="$4" d="/etc/systemd/system/$1.service.d"; sudo mkdir -p "$d"
  printf '[Service]\nRestart=on-failure\nRestartSec=10\n' | sudo tee "$d/10-restart.conf" >/dev/null
  printf '[Service]\nMemoryHigh=%s\nMemoryMax=%s\nCPUQuota=%s\nTasksMax=4096\n' "$mh" "$mm" "$cpu" | sudo tee "$d/20-limits.conf" >/dev/null; }
add_to_watchdog(){ local wk="$1" s="$2" n="$3" svc; svc="$(svc_name "$s" "$n")"
  [ -f "$WATCHDOG" ] || { warn "no watchdog — $n UNMONITORED"; return; }
  grep -q "|$n|" "$WATCHDOG" && return; sudo sed -i "/^RUNNERS=(/a\\  \"${wk}|${s}|${n}|${svc}\"" "$WATCHDOG" && log "  watchdog += $n"; }
ensure_runner(){ local wk="$1" s="$2" n="$3" dir="$4" extra="$5"
  if [ -d "$dir" ] && [ -f "$dir/.runner" ]; then log "  $n already configured"; return; fi
  [ -f "$TARBALL" ] || die "no tarball $TARBALL"; log "  provisioning $n"; mkdir -p "$dir"; tar xzf "$TARBALL" -C "$dir"
  local t; t="$(reg_token "$s")" || die "no token $s"
  ( cd "$dir" && ./config.sh --url "https://github.com/$s" --token "$t" --name "$n" --labels self-hosted,wsl2 --unattended --replace >/dev/null ) || die "config.sh $n"
  ( cd "$dir" && sudo ./svc.sh install "$SVC_USER" && sudo ./svc.sh start ) >/dev/null || die "svc.sh $n"
  if [ "$extra" = "1" ]; then write_dropins "$(svc_name "$s" "$n")" 3G 6G 200%; sudo systemctl daemon-reload
    sudo systemctl restart "$(svc_name "$s" "$n").service" >/dev/null 2>&1 || true; fi
  add_to_watchdog "$wk" "$s" "$n"; }
cmd_setup(){ [ "$RUNNERS_PER_REPO" -ge 1 ] || die "need >=1"
  [ "$RUNNERS_PER_REPO" -le 2 ] || warn "RUNNERS_PER_REPO=$RUNNERS_PER_REPO on ~11 GiB is aggressive — watch free -h"
  command -v gh >/dev/null 2>&1 || die "no gh"
  for e in $(filter_repos); do IFS='|' read -r k s b <<<"$e"; log "$s -> $RUNNERS_PER_REPO runner(s)"
    ensure_runner "$k" "$s" "$b" "$RUNNER_HOME/$k" 0
    for n in $(seq 2 "$RUNNERS_PER_REPO"); do ensure_runner "${k}-${n}" "$s" "${b}-${n}" "$RUNNER_HOME/${k}-${n}" 1; done; done
  sudo systemctl daemon-reload; log "done. verify: bash $0 --list"; }
cmd_remove(){ for e in $(filter_repos); do IFS='|' read -r k s b <<<"$e"
    for dir in "$RUNNER_HOME/${k}-"*; do [ -d "$dir" ] || continue; local sfx n; sfx="${dir##*-}"; n="${b}-${sfx}"; log "removing $n"
      ( cd "$dir" && sudo ./svc.sh stop && sudo ./svc.sh uninstall ) >/dev/null 2>&1 || true
      local t; t="$(rm_token "$s")" && ( cd "$dir" && ./config.sh remove --token "$t" >/dev/null 2>&1 ) || warn "  deregister $n maybe failed"
      rm -rf "$dir"; [ -f "$WATCHDOG" ] && sudo sed -i "\|${n}|d" "$WATCHDOG" 2>/dev/null || true; done; done
  sudo systemctl daemon-reload; log "extras removed (kept #1)"; }
case "${1:-setup}" in --list|list) cmd_list;; --remove|remove) cmd_remove;; setup|"") cmd_setup;; *) die "unknown: $1";; esac
