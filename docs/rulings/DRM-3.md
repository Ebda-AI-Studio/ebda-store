# DRM-3

> Section: Backlog batch d-routes-mcp (2026-10-01)

**Ruling DRM-3 — `admin_get_order` keeps `transactionId`/`invoiceId`, drops `paymentUrl`
(PR 2301 audit).** An unpaid order's `paymentUrl` is a live hosted-checkout link, a bearer capability
that has no place in a third-party LLM transcript. It is removed from the allowlist, and the
integration test asserts that no payment carries it. The gateway transaction and invoice ids are
kept: they are what a merchant quotes to the gateway's support to reconcile an order, and they
authorise nothing on their own. Cost if wrong: a gateway that accepts a bare invoice id as a lookup
key would let a transcript reader see that invoice's status at the gateway.
