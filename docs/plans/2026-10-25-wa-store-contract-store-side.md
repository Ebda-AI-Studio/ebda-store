# Ebda Store side of the WhatsApp contract (producer, consumer, buyer key)

Source of truth: `business/ebda/plans/2026-10-24-ebda-whatsapp-store-contract.md` (accepted 2026-10-24, addendum 2026-10-25). Scope here: sections 3, 4 (order, COD, shipping events), 6 and 8. Not here: `WhatsAppBridge` RPC (5), plan events (1), `store.linked` flow, catalog/cart events (their own PRs).

**Finish line.** (1) The envelope file equals the WhatsApp repo's bytes (sha256 pin). (2) A linked store's new order, COD request, status change and shipment update reach Queue `ebda-wa-events` as valid envelopes with deterministic ids; an unlinked store or a phone-less order sends nothing. (3) `ebda-store-events` messages (COD confirmed / refused / no_reply, order after erasure) are applied once, in the store's tenant scope, the Store staying the only order writer. (4) `buyerKey` = HMAC-SHA256(SUITE_BUYER_KEY_SECRET, E.164) matches the pinned vector; the Worker refuses to boot with the queue bound and no secret. Must NOT change: the order status machine, the Inngest fan-outs, anything for a store that has not linked WhatsApp.

## Decisions

- **Vendored file** `apps/api/src/contracts/wa-v1.ts`, byte-identical (prettier-ignored), pinned by `tests/unit/wa-contract-pin.test.ts`. It lives under `apps/api/src` because the API compiles with `rootDir: ./src` and ships `dist/`; a root-level `contracts/` could not be imported without changing the build layout.
- **Producer** = one Inngest/job-layer function `wa-store-events` (triggers `order/created`, `order/status-changed`, `shipment/status-updated`): retries, failure alerts and the rollout flag come free; the emit sites stay one `inngest.send` line (new: carrier status change). Envelope ids derive from the source event id + type, so a retry re-sends the same envelope and the consumer dedupes.
- **Gate** (Ruling WA-LINK-1): the server-only `store_whatsapp_links` row (migration `20261104000100`, written only by `WhatsAppLinkService`) AND the plan's `whatsappAutomation` entitlement, fail closed. `settings.ebdaWhatsApp` is a reserved key: 400 from the routes, stripped/preserved by `StoreService`. No link, no traffic, no phone leaves the Store.
- **Consumer** (Ruling WA-COD-1) `lib/wa/store-events-consumer.ts` on `ebda-store-events` (retries 5, DLQ `ebda-store-events-dlq`): confirmed: pending -> confirmed; refused: pending/confirmed -> cancelled (normal cancel path restores stock); no_reply: audit only; a paid / shipped / terminal order ignores a late answer. Seen-marker (`wa-in:<id>`, 7 d) written AFTER the action.
- **CI-1 (contract section 8 wins over the brief)**: the Store does NOT emit `commerce_outcomes` for outcomes that arrived from WhatsApp (WhatsApp already emitted them); it tags `source: whatsapp` in the audit trail. No duplicate rows in CI.
- **No HMAC on queue messages**: the contract's only HMAC is `buyerKey`. Both queues are account-internal (same Cloudflare account), so no per-message signature was invented.
- Secrets (env only, boot fails loud): `SUITE_BUYER_KEY_SECRET` (>= 32 chars, same value in the WhatsApp Worker). `COD_CONFIRMATION_HOURS` (var, default 24).

## Verify

Unit: envelope pin, buyer-key vector and normaliser spellings, producer (COD pair, retry-same-ids, not linked, no phone, enqueue failure throws, enum mapping), consumer (every outcome x order state, duplicates, invalid, erasure race, queue wiring). workerd: the buyer-key vector on the real WebCrypto (`workers-test/buyer-key.test.ts`).

## Connect / disconnect (store.linked / store.unlinked)

The link is changed in Store admin, not by a queue message: the envelope has no WhatsApp-to-Store link event, and the contract has the Store EMIT `store.linked` / `store.unlinked` when the merchant connects. `POST` / `DELETE /stores/:storeId/whatsapp-link` (owner/admin + MFA, plan entitlement on connect, fail closed) writes the server-owned row through `WhatsAppLinkService` and enqueues the event in the same request transaction: an enqueue failure rolls the write back. `GET` returns `{ linked, entitled, active }`. A Basic/Growth store that bought the package separately stays blocked until Ebda WhatsApp provides an entitlement source.
