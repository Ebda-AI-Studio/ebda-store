# Rollout: Ebda names replace the inherited service, token and env names

Code accepts BOTH old and new names for one release (removal date 2026-12-01),
so deploys do not break live sessions. Names only below, never values.

## 1. Before deploying the API

Nothing to create in the API worker. (The Meta provisioner and its `EBDA_META_*` secrets were removed with the legacy WhatsApp bridge, Ruling WA-LEGACY-1.)

GitHub: nothing new is required for these changes. `SENTRY_PROJECT_*`, `AXIOM_DATASET` and
`OTEL_SERVICE_NAME` keep working as they are; see steps 5-7 for when to change them.

## 2. Deploy order

1. API worker (accepts old + new JWT claims, new + old env names).
2. Admin and orders apps (write the new hint cookie, read and clear both).
3. Verify: sign in, refresh a session, hit `/health`.

## 3. Inngest (do right after the API deploy)

The app id changed, so Inngest registers a NEW app next to the previous one. Both point at
the same serve URL, so until the previous app is archived every cron fires twice and
event-triggered functions run twice. In the Inngest dashboard: confirm the new app synced
and lists the expected functions and cron schedules, then archive the previous app
immediately. Archiving can drop in-flight runs and pending `sleep` / `waitForEvent` steps
(abandoned-cart sequences are the main one); do it off-peak.

## 4. Sentry

Rename the API project's slug to `ebda-api` (Settings > Projects > General). Short issue ids
become `EBDA-API-n` (code comments already use the new form); update any alert rule or
webhook that filters on the slug. The DSN does not change.

## 5. Axiom

Datasets cannot be renamed: create `ebda-api-railway`, set `AXIOM_DATASET` to it on the API,
repoint dashboards and monitors, keep the previous dataset until its retention lapses.

## 6. Tracing

If `OTEL_SERVICE_NAME` is unset the service name is now `ebda-api`; update Tempo/Grafana
dashboards and queries that filtered on the previous name, or set the variable explicitly.

## 7. Railway

Rename the API service to `ebda-api` only if it is still deployed there. Nothing in the repo
references its internal hostname. docker-compose and pm2 already use the new name.

## 8. After 2026-12-01

Open one PR that deletes every fallback marked `TODO(2026-12-01)`: the JWT claim lists, the
hint cookie, the env fallbacks and the bridge id aliases, empties
`tests/unit/branding-allowlist.json`, and removes the allowlist entries from the guard.
