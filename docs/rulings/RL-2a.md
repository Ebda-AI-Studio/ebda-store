# RL-2a

> Section: Backlog batch x-api (2026-10-01, branch `fix/backlog-x-api`)

**Ruling RL-2a — a payment webhook is saved first but never acted on before its signature
verifies (issue 2065; amends RL-2).** The persist-first inbox is kept (every delivery is replayable
from `/webhook-events`). The fail-open was in the consumer: `handleWebhook` skipped verification
when called with no signature. A missing signature is now refused (`400 MISSING_SIGNATURE`) before
the payload is parsed or any payment is read, exactly like a wrong one. NOT done: a dedicated
per-IP limiter on the webhook mount (RL-2's flood bound) — the owner's decision did not ask for
it. Cost if wrong: a flood of unsigned-but-headered calls still costs one inbox row each, bounded
by the shared limiter.
