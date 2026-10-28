# SOUQ-CI-1

> Section: 2026-10-21 — Phase B2 Souq (B2-\*)

- Ruling SOUQ-CI-1: `tests/unit/souq-demo-assets.test.ts`'s real-image orange sweep needs `dwebp` (libwebp-tools), which the self-hosted CI runners do not have, so it failed there with "No such file or directory: 'dwebp'". The sweep is skipped ONLY when `CI` is set and `dwebp` is absent; locally it still fails closed, and the pre-push gate on the Mac runs it. The probe's own positive and negative controls and the undecodable-file test still run on CI. Cost if wrong: a committed Souq image with too much orange would pass CI and be caught only by the pre-push gate; fix by installing libwebp-tools on the runners and dropping the skip.
