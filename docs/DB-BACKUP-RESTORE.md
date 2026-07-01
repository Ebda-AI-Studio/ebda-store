# Database backups & restore

Two independent layers, both **$0** and encrypted; no Neon branches.

## Layer 1 — local (Mac, launchd)
Central script `~/.claude/scripts/backup-all-neon.sh` (launchd `com.forceai.neon-backup`, 03:30 daily)
gzip-dumps every Force Neon DB to `~/Desktop/projects/_backups/<project>/`, keeps **30** (≈1 month).
Requires `pg_dump` ≥ the Neon server major (PG17 → `brew install postgresql@17`) and the **DIRECT**
(non-pooler) url. It now also encrypts + pushes each dump to R2 when R2 creds are present.

## Layer 2 — off-machine (GitHub Actions → private R2, Mac-independent)
`.github/workflows/db-backup.yml` runs daily 03:50 UTC (+ `workflow_dispatch`): pg_dump 17 → gzip →
AES-256-CBC (openssl, pbkdf2) → upload to `s3://databasebackup/<project>/`. Prunes objects >30 days
(the bucket also has a 30-day lifecycle rule). **Fails loudly** (Telegram) on empty output.

### Required repo secrets
`DATABASE_URL_DIRECT` (Neon direct owner url) · `BACKUP_ENCRYPTION_KEY` (`openssl rand -hex 32` — SAVE IT,
needed to restore; also stashed at `~/.claude/.<project>-backup-key`) · `R2_ACCOUNT_ID` ·
`R2_ACCESS_KEY_ID` · `R2_SECRET_ACCESS_KEY` · `R2_BUCKET=databasebackup`.

## Restore
```bash
# fetch the .enc from R2 (or use a local ~/Desktop/projects/_backups/<project>/*.sql.gz)
KEY=$(cat ~/.claude/.<project>-backup-key)
openssl enc -d -aes-256-cbc -pbkdf2 -pass "pass:$KEY" -in <file>.sql.gz.enc | gunzip | psql "$DATABASE_URL_DIRECT"
# RLS MUST be re-applied after a restore:
npm run db:rls   # (or the project's RLS-apply script)
```
Verify a dump is valid before trusting it: `openssl enc -d … | gunzip | head` should show SQL.
