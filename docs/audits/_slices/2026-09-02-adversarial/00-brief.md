# ADVERSARIAL AUDIT BRIEF — force-website-builder (FWB)

Repo root: <repo> (this checkout; branch: main, clean — READ ONLY, make NO edits)
Scratch dir: <session scratch>/adv-audit (a working directory local to this session — write your
durable report to docs/audits/\_slices/<date>-<slug>/<YOUR-SLUG>.md instead; see Output below)

## What this is

NOT a checklist audit. FWB has had 20 checklist audits (docs/audits/) and they mostly say PASS.
You are the ATTACKER. Your job is to find the thing those audits MISSED, and to FALSIFY their PASS verdicts.

Stack: Express+TS API (apps/api, Railway) · Next.js 16 App Router admin/web/orders on Cloudflare Workers ·
Prisma + Neon Postgres with RLS · Redis (rate limit + cache) · Inngest (>300ms async) · R2 uploads ·
Gemini flash-lite for AI features · payments Tap/MyFatoorah/Hesabe/UPayments · multi-tenant by `storeId`,
web app also serves per-tenant CUSTOM DOMAINS via Cloudflare-for-SaaS host resolution.

## Method (mandatory, in order)

1. Read `graphify-out/GRAPH_REPORT.md` (5253 lines — skim structure, then query the parts you need) BEFORE grepping blind.
2. Read `CLAUDE.md` at repo root, and skim `docs/audits/` for what has ALREADY been claimed about your dimension.
3. Form an ATTACK HYPOTHESIS ("as an attacker/hostile tenant/hostile customer I can do X"). Then go prove or kill it in the code.
4. **A finding is a CLAIM until you have read the code behind it.** Grep counts are NOT findings. Follow the
   call chain end to end: entry point -> middleware -> handler -> service -> DB. Most "unauthenticated route"
   hits turn out to be gated elsewhere. Kill your own false positives before reporting — a false finding costs
   more than a missed one, because it burns trust in the whole report.
5. For every finding you keep, write the CONCRETE EXPLOIT PATH: the actual request/sequence an attacker sends,
   and the observable damage. "Could be vulnerable" is not a finding. If you cannot write the exploit path,
   downgrade it to an OBSERVATION or drop it.
6. Note BLAST RADIUS: every other file/route/render-path/layer that shares the same defect (the defect CLASS,
   not the single instance). Grep for siblings.

## Output — TWO things

(a) Write your full report to `docs/audits/_slices/<date>-<slug>/<YOUR-SLUG>.md` (the durable
destination — this is what ships in the PR) using the finding format below.
(b) Return to the orchestrator a COMPACT summary: your slug, the count by severity, and a one-line title +
file:line for each P0/P1. Do NOT dump the whole report into your reply.

### Finding format

```
### [P0|P1|P2|P3] <short title>
- **Where:** path/to/file.ts:LINE (+ every sibling location)
- **Attack:** the concrete request/sequence an attacker sends
- **Damage:** what they get (cross-tenant data? free order? outage? cost burn?)
- **Evidence:** the code that makes it work, quoted, with file:line
- **Why prior audits missed it:** (if a prior audit claims PASS on this ground, name the file and the claim)
- **Blast radius:** other locations/layers with the same defect
- **Fix:** 1-3 sentences, specific
```

Severity: P0 = exploitable now, real money/data/outage. P1 = exploitable with a precondition.
P2 = defense-in-depth gap or a real bug that needs an unlikely trigger. P3 = hygiene.

### Also report, explicitly

- **FALSIFIED:** any prior-audit PASS you disproved (name the audit file + its claim + your counter-evidence).
- **UPHELD:** the top 2-3 defenses you attacked hardest and could NOT break (this is signal too — say what you tried).
- **BLIND SPOTS:** what you could not verify statically and what would settle it (a query, a curl, a log).

Be adversarial about your own report too: before you finalise, re-read each finding and ask "would a senior
engineer looking at this code agree, or would they show me the line that makes it safe?"
