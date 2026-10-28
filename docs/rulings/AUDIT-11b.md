# AUDIT-11b

> Section: 2026-10-07 — AUDIT-P2P3 (FIX-011..015, branch `fix/audit-p2-p3`)

Ruling AUDIT-11b — ACCEPTED RESIDUAL: `braces` (GHSA-vfj7-8cjw-p6xm, <=3.0.3, stack-exhaustion DoS on deeply nested brace patterns) stays. The registry's `latest` is 3.0.3 (last published 2024-09-18), so NO patched version exists to upgrade or override to; a scoped override to the same version changes nothing. It enters only through dev/build tooling (tailwindcss 3 > chokidar/micromatch, tsc-alias > chokidar) whose glob patterns are repository-owned, never request input. Re-check with `npm view braces dist-tags` and `npm audit` each release; remove this ruling when a patched version ships. Ebda's `LAUNCH-3` already accepted the same residual; this entry supersedes its evidence with the 2026-10-07 re-check. Cost if wrong: a malicious brace pattern could hang a build or lint step on a developer or CI machine; no runtime path reaches it.
