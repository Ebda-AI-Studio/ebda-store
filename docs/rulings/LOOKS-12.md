# LOOKS-12

> Section: 2026-10-14 — Security batch (branch `fix/security-batch-2026-10-14`, audit: `docs/security/audit-2026-10-14.md`)

Ruling LOOKS-12 — `Cache-Control: private, no-store` applies to ANY store host carrying a well-formed `?look=`, not only demo stores. Evidence: middleware is synchronous and cannot know `is_demo`, and the response for a non-demo store is otherwise identical to the one without the param, so this is the safe direction; the header is forwarded as `x-demo-look` and a client-sent copy is stripped. Cost if wrong: a rare `?look=` URL on a real store is uncached.
