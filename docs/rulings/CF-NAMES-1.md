# CF-NAMES-1

> Section: 2026-10-07 — INFRA-GAPS (branch `fix/infra-gaps`)

Ruling CF-NAMES-1 — FIXED: Workers renamed `force-{web,admin,orders}-cf-preview` to `ebda-{web,admin,orders}` in wrangler configs, `scripts/cf-setup-local.sh`, the workers.dev CORS regex, the hosts test and living runbooks. `wrangler deployments list` returned code 10007 (Worker does not exist) for all three old names and all three new ones on account 69188202..., so nothing is deployed or orphaned. Historical plans and earlier rulings keep the old names. The R2 bucket `force-web-opennext-cache` is deliberately NOT renamed. Cost if wrong: a first deploy under the new names needs its secrets set fresh (nothing exists to migrate).
