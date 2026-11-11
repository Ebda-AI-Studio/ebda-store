# Escalation — who is contacted, how, and how fast

Written 2026-11-10 (Iceberg audit #34, was ❌). Triage steps live in [`../INCIDENT.md`](../INCIDENT.md); this page is
only **who, which channel, how fast, what next**.

## People and channels today

| Role                       | Who                                                                                      | Reached by                                                                                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Watcher (24/7, today)      | **The Whisky AI OS** (now in `ebda-foundation/os`: prod-watch + the brain `os.ebda.app`) | watches production every 10 min and CI, alerts on Telegram; its hands (fix PRs) are **halted** (`HANDS_HALT=1`) until Ahmad enables them                                  |
| First responder (today)    | Ahmad Sharaf                                                                             | **Telegram alert chat**, @EbdaAIStudiobot, chat `1943728711` (P1s, one daily digest, OS questions; also status.ebda.app, API alert bridge, Sentry, backup/drill failures) |
| Merchant support (inbound) | Ahmad                                                                                    | WhatsApp `+20 151 419 1411` (`BRAND.contact.whatsapp`) and `ahlan@ebda.app` (`BRAND.supportEmail`, forwarded by Cloudflare Email Routing)                                 |
| Security reports           | Ahmad                                                                                    | `security@ebda.app` (security.txt)                                                                                                                                        |
| Second human operator      | **none yet**                                                                             | see "If Ahmad is unreachable"                                                                                                                                             |

All alerting goes to ONE Telegram chat; there is no paging service. Keep Telegram notifications for that chat
**unmuted with sound, including at night**, or P0 response times below are fiction.

## Who acts first (Ruling ESC-AIOS-1)

**Today (2026-11-11).** The Whisky AI OS, now living in `ebda-foundation/os`, watches and alerts: prod-watch probes
production every 10 minutes from outside Cloudflare and reports into the brain (`os.ebda.app`), which also receives CI
events. Its hands are halted (`HANDS_HALT=1`, the committed default) and the brain still lacks its GitHub and Cloudflare
read tokens, so the OS fixes nothing yet. **Ahmad is the first responder** for every alert until he enables the hands.

**Target (Ahmad, 2026-11-10).** The Whisky AI OS becomes the primary DevOps operator and Ahmad the backup. Once Ahmad
issues the tokens and sets `HANDS_HALT=0`:

- **The OS acts** on what it can fix through a pull request: CI red on `main`, failing tests, dependency advisories, docs.
  It takes no repo a controller session holds a lease on (`os/ops/controller-lease.sh`), and never edits files another open PR
  already changes. It never merges, never deploys and never rolls back: a merge goes through `merge-gate.sh` by a controller
  session or Ahmad.
- **Ahmad is asked** (one Telegram question, never silence) for anything touching money, auth, production data, deploy
  config, secrets or anything destructive, and gets every unhealed P1 plus one daily digest. Telegram is capped (P1s + digest),
  so a message from the OS means a human is needed.
- **Kill switch:** `HANDS_HALT=1` on the brain or `POST /api/halt` from the dashboard stops all OS fixes at once.

When the hands go live, update the table above (Watcher -> Primary operator, First responder -> Human backup).

Ruling ESC-AIOS-1 — the Whisky AI OS (now in `ebda-foundation/os`) is the target primary DevOps operator and Ahmad the human
backup; today it watches and alerts only, its hands are halted, and Ahmad is the first responder until he enables them. When
live, the OS opens PRs only and asks Ahmad on Telegram for money, auth, production-data and destructive changes. Evidence:
Ahmad, 2026-11-10 ("the Whisky AI OS is the main DevOps and the one here to solve everything, and I'm the backup person");
launch-map row HANDS-COORD; `ebda-foundation/docs/plans/2026-11-10-aios-primary-operator.md`; `HANDS_HALT=1` in
`os/cloud/brain/wrangler.jsonc`. Cost if wrong: a P0 the OS cannot fix by PR (a Worker rollback, a leaked secret) still waits
for Ahmad, exactly as before; the response targets below stay his.

## Response targets

| Severity | Acknowledge | Merchant update                                                                           | Fix or mitigation target |
| -------- | ----------- | ----------------------------------------------------------------------------------------- | ------------------------ |
| P0       | 15 min      | status.ebda.app shows it automatically; personal message to affected merchants within 1 h | 4 h                      |
| P1       | 1 h         | reply to the reporting merchant within 4 h                                                | 1 business day           |
| P2       | same day    | when fixed                                                                                | 1 week                   |
| P3       | backlog     | none                                                                                      | next release             |

## Playbooks

### P1/P0 — store(s) down (status.ebda.app red, storefront 5xx/timeouts)

1. Acknowledge in the Telegram chat (reply "on it") so the timeline has a start.
2. Triage with INCIDENT.md steps 1-5 (health + commit, Worker tail, D1, jobs, recent deploys).
3. Recent deploy? Roll that Worker back first (`cd apps/<app> && npx wrangler rollback`), investigate second.
4. Down > 30 min: post a short note to affected merchants (WhatsApp), Egyptian Arabic, what is affected and the next
   update time. status.ebda.app already shows the incident publicly.
5. Resolved: confirm on status.ebda.app + `/health` commit, message merchants, postmortem within 48 h.

### Payment issue (charge wrong, webhook failing, InstaPay not confirmed)

1. Treat as **P0** if money moved wrongly (double charge, refund lost, order paid but not recorded); P1 if one
   provider's payments fail while COD/InstaPay work.
2. Never "fix" money by hand in the database. Check the super-admin `/webhook-events` inbox (replay is idempotent) and
   the provider's merchant portal (the merchant's OWN Paymob/Kashier/Fawry account).
3. Tell the merchant what to tell their customer (e.g. "keep the order, we confirm the payment within X").
4. Ebda's own subscription payments (InstaPay, confirmed manually): an unconfirmed transfer must never suspend a store;
   confirm or extend first, investigate second.

### Data incident (leak, wrong store sees another's data, lost data)

1. **P0.** Contain first: roll back the Worker or disable the route; do not wait for a root cause.
2. Preserve evidence: do not delete logs; note times; export the relevant Workers Logs / `ebda-logs` objects.
3. Lost or corrupted data: recover per `DB-BACKUP-RESTORE.md` (D1 Time Travel / DO PITR within 30 d, else the nightly
   dump). Re-run the erasure ledger after any restore.
4. Personal data exposed: assess within 24 h which merchants/shoppers are affected; Egyptian PDPL (151/2020) and GDPR
   notification duties apply (72 h to the authority under GDPR). Notify affected merchants in writing; record the
   decision and evidence as a Ruling.

## If Ahmad is unreachable (current gap)

There is no second person with Cloudflare + GitHub access today. Until there is, the platform keeps itself up only through
automation: the Whisky AI OS (it watches and alerts; once its hands are enabled it opens fixes, but never merges or deploys them), status probes,
`cf-api-deploy.yml` auto-rollback, retries + dead-letter queues, nightly backups. Nobody can
roll back a Worker, rotate a leaked secret or answer merchants. Naming a backup operator (even part-time), with a
Cloudflare account member role, GitHub org access, a copy of this page and the location of the age backup key, is
Ahmad's decision; it is in the approvals queue. When one exists, add them to the table above and to the Telegram chat.
