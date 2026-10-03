#!/usr/bin/env bash
# Recreates the spike DB (dev only; fake credentials). Run as root.
set -euo pipefail
cd "$(dirname "$0")/.."
su postgres -c "psql -v ON_ERROR_STOP=1 -q -c 'DROP DATABASE IF EXISTS ebda_spike WITH (FORCE)'"
su postgres -c "psql -v ON_ERROR_STOP=1 -q -c 'CREATE DATABASE ebda_spike'"
cat prisma/migrations/*/migration.sql | su postgres -c "psql -v ON_ERROR_STOP=1 -q -d ebda_spike"
su postgres -c "psql -v ON_ERROR_STOP=1 -q -c \"ALTER ROLE ebda_app PASSWORD 'ebda_app_dev_only'\""
cat prisma/seed.sql | su postgres -c "psql -v ON_ERROR_STOP=1 -q -d ebda_spike"
echo "db ready"
