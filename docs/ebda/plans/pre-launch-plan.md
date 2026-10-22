# Ebda (ابدأ) — pre-launch plan

Written 2026-09-27. Owner: Ahmad. Order is binding: phase 0 must be done before
phase 1 starts, and so on. Each phase ends with evidence, not "looks done".

## Phase 0 — finish Ebda Store (in progress)

- Every open Ebda Store PR merged and verified live (health commit, cf-deploy per app,
  5 hosts, the changed path measured).
- Last backlog sweep: every open issue fixed, or closed with evidence, or on a
  short list of owner questions.
- Follow-ups already queued: #1956 (partial card refund on a wallet-paid order),
  card-label placement #1996/#1998 (before/after screenshots for Ahmad), sitemap
  empty-200 on a store-list outage, `googleAdsSendTo` module variable under
  tenant routing, CI guard that new migrations sort after main's newest.
- RLS role flip, attempt 2: payload parity against a restored copy of prod
  data, soak list, then flip with rollback ready.
- Done when: open-issue count is 0 (or only owner questions), prod verified.

## Phase 1 — lessons from this session become rules, tools and skills

Every lesson gets BOTH halves: a memory file (with the "indexed in global
MEMORY.md" sentinel so it reaches the OS) AND an enforcing artefact (a script,
a check, a skill, or a standard doc). A lesson only in chat is lost.

### Skills to create (candidates)

| Skill                 | What it packages                                                                                                                                                                                                                                             | Source this session                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `merge-lane`          | single-lane merge train: head-only CI, cancel non-head runs, BEHIND update, audit gate, auto-resolve of append-only files (RULINGS union, defence-record regen, i18n JSON 3-way deep merge, workflow path lists), post-merge verify-deploy, worktree cleanup | `/tmp/claude-501/lane.sh`, `auto-resolve.sh`, `json-merge.py`, `union-hunks.py`, `verify-deploy.sh`, `clean-merged-wt.sh` |
| `pr-refresh`          | refresh a stale PR onto main safely: keep both sides, money-conflict stop rule, migration re-ordering, regenerate generated files, run BOTH tests/unit and colocated app tests, parity for money code                                                        | `/tmp/claude-501/refresh-prompt.md`                                                                                       |
| `buy-flow-parity`     | when/how to run the harness, read `result.json` not the exit code or a `                                                                                                                                                                                     | tail`, compare vs origin/main not only vs the old baseline                                                                | Ebda Store `scripts/buy-flow-parity/` |
| `umbra-ci-recovery`   | post-reboot / post-rebuild checklist for ebda-ci6 (runners per repo, docker run, hosts pin, kernel, doctor) and what NOT to conclude from symptoms                                                                                                           | this session's CI incidents                                                                                               |
| `prod-readonly-check` | read-only prod SQL through the Railway DATABASE_URL with positive controls (psql `-c` prints only the LAST statement; check key length; one statement per call)                                                                                              | this session's prod checks                                                                                                |

### Where the skills live (owner decision 2026-09-27: part of the AI OS)

Each skill is codified in TWO places, never only in `~/.claude/skills`:

1. **the shared ops foundation** (the OS source): `skills/<name>/` in the same shape
   as the existing `skills/force-audit/` (SKILL.md + scripts + fixtures +
   tests), its scripts under `ops/` where they are OS jobs, a graded rubric
   item in `standard/` that cites the lesson slug, and installed by
   `ops/install.sh` so `~/.claude/skills/<name>` is the generated copy.
2. **mypovonai-learn audit package** (`fleet/`): each rule the skill enforces
   ships as a probe plus a known-bad fixture the probe must flag, so the audit
   grades it on every project (`fleet/parity.test.mjs` fails if a standard
   lens has no probe). A lens in `standard/` with no fleet probe grades nothing.

Done when: every skill is installed from foundation by install.sh, has a
standard/ item, has a fleet probe whose known-bad fixture fails and whose
known-good fixture passes, and has been invoked once on a real case.

### Lessons to write down (memory + enforcement)

1. **Stale PRs in a serial queue.** Every merge makes the next PRs conflict.
   Refresh in parallel ahead of the queue, and auto-resolve append-only files.
2. **Migration ordering across parallel PRs.** A migration whose timestamp is
   older than one already applied in prod must be renamed before merge.
   Enforce with a CI check.
3. **Pre-push only runs `tests/unit`.** Colocated `apps/*/…test.ts` run only in
   CI, so refreshes must run both.
4. **Agents must never run `neonctl`.** It opens a browser login on Ahmad's Mac.
5. **commitlint rejects body lines starting "#n".** Write "issue 1649".
6. **Git env leaks from hooks.** Tests that spawn git must strip `GIT_*`, or they
   corrupt `.git/config` (core.bare).
7. **A merge that skips an app hides a failed deploy.** Enumerate every deploy
   job per merge; re-run the failed one.
8. **Shell traps:** macOS has no `timeout`; zsh `$var:g…` is a modifier (use
   `${var}`); `cmd | tail` reports tail's exit code; `psql -c` with several
   statements prints only the last.
9. **The review bot finds real P1s.** Treat a BLOCKED verdict as a bug report;
   the lane must never merge past it.
10. **Recovery tools can cause the outage.** ci-runner-guard rebuilt the CI VM
    every 3 h on a false doctor signal; each rebuild wiped runners and pins.
    Any auto-remedy needs a negative control on a known-good machine.

### Global CLAUDE.md

Rewrite for clarity, not length. Planned changes:

- One short "hard rules" block at the top (money, prod, secrets, destructive
  actions, identity), each one line with the enforcing file named.
- Move long explanations into memory files; CLAUDE.md keeps the rule + a link.
- Add: merge-queue rules, migration ordering, refresh-both-test-suites,
  no-neonctl, GHAS stays off, verify every deploy job, positive controls on
  every "0 rows / empty / pass" result.
- Remove anything stale (checked against the machine, not assumed).

## Phase 2 — Umbra stability (close the gaps found this session)

| Gap                                                                   | Fix                                                                                                                        | Proof                                              |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| doctor `guest-binaries-missing` false positive (Permission denied)    | umbra PR #56 (done locally)                                                                                                | merge #56; doctor healthy on a fresh guest         |
| ci-runner-guard auto-rebuilds on one signal with no negative control  | require the signal to reproduce under `sudo` / a second probe before rebuilding; alert instead of rebuild on a fresh guest | unit test with a fresh-guest fixture               |
| Rebuild loses host pins (R2 populate `188.114.97.6`)                  | carry extra `/etc/hosts` entries in the machine seed / cloud-init; and ensure it in `cf-deploy.yml` on self-hosted runners | rebuild, then a storefront deploy passes first try |
| `umbra runner restore` partial; second run fails "already configured" | make restore idempotent (skip configured units, re-register orphans)                                                       | rebuild twice; every repo online                   |
| Installing the CLI by `cp` over the binary → Killed: 9                | install via rm + cp + codesign in the Makefile's install target                                                            | `make install` then `umbra list`                   |
| Host memory pressure (16 GiB, heavy swap) freezes the guest           | cap parallel agents; keep the guest at 4 GiB; alert on host swap > 75%                                                     | swap stays under the line during a CI burst        |
| Unknown restarts were misdiagnosed (kernel, disk)                     | record every guard action in one log with the reason, surfaced in the daily brief                                          | next incident is explained from the log alone      |

## Phase 3 — Ebda on Cloudflare (design first, then build)

Owner decision (2026-09-26): Ebda's backend runs on Cloudflare, not Railway.

1. **Design doc before any code.** Map every Ebda Store API dependency to its
   Cloudflare equivalent:
   - Express API → Workers (Hono or a thin router); keep the route contracts.
   - Postgres (Neon) via Hyperdrive; Prisma on workerd uses the pg adapter (see
     memory `feedback-tests-exercise-a-driver-production-does-not`: tests must run
     on the same driver + runtime as prod).
   - Redis (rate limits, caches) → Durable Objects / KV / Workers rate-limiting,
     one choice per use with its consistency needs written down.
   - Inngest background jobs → Cloudflare Queues + Cron Triggers, or keep Inngest
     calling a Worker (decide by the step/retry semantics we rely on).
   - R2 already in use for images and the Next cache.
   - Email (Resend) and payments (MyFatoorah → Paymob/Kashier/Fawry/InstaPay for
     Egypt) from Workers.
2. **Spike:** port three representative routes (a public read, a cart write, a
   payment webhook) and run the buy-flow parity harness against them.
3. **Decide:** full port vs. staged (storefront reads first, writes later).
4. Then the Ebda clone steps already agreed: whisky-11/ebda with Ebda Store as
   upstream, twin-sync tooling, rebrand (night + Antique Gold), EGP minor units,
   Egyptian payments, the Nile login animation, Amal's store as merchant #1.

## Order and evidence

| Phase | Done when                                                                                                                                                                                                                                                                                          |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Ebda Store open issues 0 (or owner list), every PR merged + verified live                                                                                                                                                                                                                          |
| 1     | each lesson has a memory file with the sentinel AND an enforcing artefact; each skill lives in the shared ops foundation (skills/ + standard/ + install.sh) AND ships a probe + known-bad fixture in mypovonai-learn/fleet; invoked once on a real case; CLAUDE.md rewritten and reviewed by Ahmad |
| 2     | two consecutive rebuilds of ebda-ci6 come back fully working with no manual step; doctor healthy on a fresh guest                                                                                                                                                                                  |
| 3     | design doc approved by Ahmad; spike passes parity; then the clone                                                                                                                                                                                                                                  |
