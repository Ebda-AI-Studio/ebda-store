# ICEBERG-BK-3

> Section: Iceberg quick wins (2026-11-10)

**Ruling ICEBERG-BK-3 - the off-account copy is a Mac launchd job (`app.ebda.cf-backup-pull`, `scripts/ops/pull-cf-backups.mjs`) that pulls the newest encrypted set and the media mirror over api.cloudflare.com, sha256-checks each file, keeps 30 day folders; it lives in ebda-store/scripts/ops because ebda-foundation has no ops/install.sh pattern yet.** ebda-foundation ops/ holds host-lock and merge-gate only (checked 2026-11-10). Live read-only run 2026-11-10 downloaded and verified 7 real artifacts (468 KB) and failed on the missing identity artifact as designed. It needs an R2-read token in Keychain `ebda-r2-backup-read` (approvals queue). Cost if wrong: until Ahmad installs it and creates the token the Cloudflare-account-loss path still has no copy of identity or media (the older Mac pull of the Worker sweep covers platform D1 + StoreDOs only).
