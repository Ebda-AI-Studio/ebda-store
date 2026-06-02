#!/usr/bin/env bash
# fix-wsl-runner.sh — heal the recurring WSL self-hosted runner flakes.
# Idempotent; safe to re-run. Run INSIDE WSL Ubuntu on the runner box:
#     bash fix-wsl-runner.sh
# Targets: 1) jq missing -> exit 127; 2) docker daemon down; 3) DNS flaps.
set -uo pipefail
log(){  printf '\033[36m[fix-wsl]\033[0m %s\n' "$*"; }
warn(){ printf '\033[33m[fix-wsl]\033[0m %s\n' "$*"; }
# 1. jq
if command -v jq >/dev/null 2>&1; then log "jq present ($(jq --version))"
else warn "jq missing -> installing"; sudo apt-get update -qq && sudo apt-get install -y -qq jq; log "jq installed ($(jq --version))"; fi
# 2. docker
if docker info >/dev/null 2>&1; then log "docker daemon up"
else warn "docker daemon down -> starting"; sudo systemctl start docker 2>/dev/null || sudo service docker start 2>/dev/null || true; sleep 2
  if docker info >/dev/null 2>&1; then log "docker daemon now up"; else warn "docker STILL down — check 'systemctl status docker'"; fi; fi
# 3. DNS (only if actually broken)
if getent hosts github.com >/dev/null 2>&1; then log "DNS resolves github.com OK — leaving resolv.conf alone"
else warn "DNS cannot resolve github.com -> pinning public resolvers"
  if ! grep -q 'generateResolvConf' /etc/wsl.conf 2>/dev/null; then
    sudo tee -a /etc/wsl.conf >/dev/null <<'WC'

[network]
generateResolvConf = false
WC
    warn "set generateResolvConf=false; full effect needs a CONTROLLED 'wsl --shutdown' (stop runner svcs first)"; fi
  sudo rm -f /etc/resolv.conf
  printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' | sudo tee /etc/resolv.conf >/dev/null
  getent hosts github.com >/dev/null 2>&1 && log "DNS now resolves" || warn "DNS STILL failing"; fi
log "done."
