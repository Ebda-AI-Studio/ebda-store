# BS-9

> Section: 2026-10-01 — backlog batch b-services (branch `fix/backlog-b-services`)

**Ruling BS-9 — issue 2215's class sweep: a best-effort DB write whose failure is swallowed is
savepointed wherever it can run inside a tenant transaction.** A heuristic scan of
`apps/api/src/{services,routes,middleware}` found 23 `try { await prisma.X.<write> } catch { log }`
sites; each was traced to its mounts. Savepointed (reachable inside a request or an explicit
`runInTenantContext`): `auditLog` (security.ts), `recordUsage` (ai.service), `recordPaymentEvent`,
the order-status `orderEvent`, `pages.remove` (now also swallows ONLY P2025), variant
`bulkUpdateInventory` (now sequential — savepoints on one connection cannot interleave), the
autofill category `createMany`, every analytics-rollup snapshot write, the citation-scan check
write, and the bulk-AI enqueue-failure mark. Left as they are, not reachable inside a tenant
transaction: account-lockout (`/auth`), abandoned-cart and SMS queue (process timers), expense OCR
(Inngest, no context), `payment.factory` `releaseClaim` (its own deliberate transaction),
wbs-integration (context-less router). Cost if wrong: a site the scan's pattern missed (a write
wrapped in a helper, or a `.catch(() => …)` chain) still poisons its request.
