# Customer Intelligence (CI): capture, internal learning, merchant features

Owner: controller. Status: CI-1 shipped (#228); CI-2 (aggregates, insights) and CI-3 (hints, Smart hints page, help article) built on the Postgres/Prisma path behind the same ports (Rulings CI-9 to CI-12); the plan text below is unchanged. CI-13 emits the rest of the 1.2 table the first cut left out (`payment.failed`, `cart.abandoned`/`cart.recovered`, `merchant.onboarding_step`), carries the real shipping fee, adds their metrics and pauses a feature for a single store when its own calibration is off (Ruling CI-13). Register: 2026-10-24 "Customer Intelligence" entry; migration plan gap G3 (`business/ebda/plans/2026-10-28-store-on-cloudflare-detailed.md`). Applies to every Ebda AI Studio product (Store now; WhatsApp, CRM, ERP feed the same stream later).

**Goal:** learn from commerce outcomes (what shipped, what was delivered, what came back and why) so Ebda can improve defaults, courier routing, COD risk, onboarding and templates, then expose proven features to merchants.
**Why now:** the capture half is unrecoverable. A return reason or a delivery time that was never stored cannot be rebuilt later. Everything else (analysis, features) can wait for data.
**Evidence labels:** field names are measured against `packages/database/prisma/schema.prisma` (Shipment :2809, 2026-10-28 tree); sizes and costs are guesses.

## 0. Rules that hold in every phase

1. **Append-only, event-fed.** CI never scans hot tables (orders, shipments). The domain write emits an event in the same transaction; everything downstream reads the event stream.
2. **Pseudonymous by construction.** The only buyer identifier is `buyerKey = HMAC-SHA256(SUITE_BUYER_KEY_SECRET, E.164 phone)`, lowercase hex, the same util and pinned test vector as the WhatsApp contract. No name, phone, email, address text or free text ever enters the stream except the raw return reason (a short carrier/merchant phrase, scrubbed by `scrubFreeText`, 200 chars).
3. **Cross-store use needs the merchant's opt-in** (`store.ciSharing`, default OFF, asked at onboarding with plain Arabic text). Without it a store's events are used only for that store's own features.
4. **Advise, never block.** No CI output can reject, delay or auto-cancel an order.
5. **Minimum-sample thresholds** (section 4) gate every number shown to anyone outside the data team.
6. **Erasable.** Every CI surface is covered by the PDPL erasure job (G10, `apps/api/src/cf/erasure/`) and the retention rules in section 1.6.
7. **No raw PII to any external model, ever** (section 3.2 enforces it with a guard, not a promise).

## 1. CI-1: capture (built into the phase-1 schema; ships before launch)

### 1.1 Schema fields the phase-1 port must include

| Where    | Field                                     | Type                                | Notes                                                                             |
| -------- | ----------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------- |
| shipment | `returnReasonRaw`                         | text, nullable                      | what the carrier or merchant wrote, scrubbed, max 200 chars                       |
| shipment | `returnReasonCode`                        | text, nullable, CHECK in list below | normalised                                                                        |
| shipment | `pickedUpAt`, `deliveredAt`, `returnedAt` | integer ms, nullable                | first time the carrier status reached that state; never overwritten               |
| shipment | `deliveryAttempts`                        | integer, default 0                  | count of "attempted, failed" statuses                                             |
| shipment | `areaKey`                                 | text                                | normalised destination, section 1.3                                               |
| order    | `areaKey`, `buyerKey`                     | text, nullable                      | `buyerKey` null when the order has no phone (never invent one)                    |
| store    | `ciSharing`                               | integer 0/1, default 0              | the cross-store opt-in; `ciSharingChangedAt`                                      |
| store DO | `ci_outbox`                               | table                               | `seq` autoincrement, `eventId` unique, `payload` JSON, `createdAt`, `sentAt` null |

`returnReasonCode` list (closed; unknown phrases map to `other` and keep the raw text): `customer_refused`, `customer_unreachable`, `wrong_address`, `address_incomplete`, `customer_postponed`, `price_dispute`, `product_not_as_described`, `damaged_in_transit`, `courier_failed_attempts`, `courier_lost`, `duplicate_order`, `fake_order`, `other`. The mapper lives next to each carrier adapter (one table per carrier, tested with the real status strings recorded in `docs/ebda/research/` fixtures); a code of `other` above 20% of a carrier's returns raises a super-admin alert (the mapper is stale).

### 1.2 The event contract: `commerce_outcomes`

One envelope, versioned, JSON:

```
{
  "v": 1,
  "eventId": "<ULID>",            // idempotency key; consumers dedupe on it
  "type": "<see table>",
  "occurredAt": 1790000000000,    // ms, when it happened (carrier timestamp when we have one)
  "recordedAt": 1790000001234,    // ms, when the Store wrote it
  "product": "store",             // store | whatsapp | crm | erp
  "storeId": "<uuid>",
  "xstore": true,                 // the merchant's ciSharing at event time
  "orderId": "<uuid>",            // opaque, no order number
  "buyerKey": "<hex64>" | null,
  "keyVersion": 1,                // SUITE_BUYER_KEY_SECRET generation
  "data": { ...per type... }
}
```

| `type`                                          | Emitted when                               | `data`                                                                                          |
| ----------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `order.placed`                                  | order row created (any channel)            | `totalMinor, currency, paymentMethod, channel, itemCount, areaKey, isFirstOrderForBuyerInStore` |
| `order.cod_confirmed` / `order.cod_unconfirmed` | the COD confirmation window closes         | `confirmedVia (whatsapp\|call\|none), minutesToConfirm`                                         |
| `order.cancelled` / `order.refunded`            | status change                              | `reason (code), byActor (customer\|merchant\|system), totalMinor`                               |
| `payment.captured` / `payment.failed`           | provider webhook applied                   | `provider, methodKind, totalMinor, failureCode`                                                 |
| `shipment.created`                              | carrier booking succeeded                  | `carrier, codMinor, areaKey, weightGrams, attemptsToBook`                                       |
| `shipment.picked_up`                            | first carrier status "picked up"           | `carrier, hoursSinceCreated`                                                                    |
| `shipment.attempted`                            | each failed delivery attempt               | `carrier, attemptNo, reasonCode`                                                                |
| `shipment.delivered`                            | first "delivered"                          | `carrier, codMinor, hoursSincePickup, attempts`                                                 |
| `shipment.returned`                             | first "returned to sender"                 | `carrier, codMinor, returnReasonCode, returnReasonRaw, attempts, hoursSincePickup`              |
| `cart.abandoned` / `cart.recovered`             | abandoned-cart rule / order after reminder | `channel (email\|sms\|whatsapp), hoursToRecover`                                                |
| `merchant.onboarding_step`                      | each onboarding step completes             | `step, secondsSinceSignup, template`                                                            |
| `customer.erased`                               | PDPL erasure of a buyer                    | `buyerKey` only, no other fields (drives the erasure of CI rows, not a learning input)          |

Rules: emit sites are enumerated in `apps/api/src/cf/ci/emit-sites.ts` and a guard test greps the codebase for every status write path (`shipment.status =`, order status transitions) and fails when one has no emit or an explicit `// ci: not-an-outcome` waiver (the cache-invalidation rule: every write path). First-time-only events (`picked_up`, `delivered`, `returned`) are guarded by the nullable timestamp column, so carrier polling twice never double-emits. Adding a field is a minor change inside `data`; renaming or removing one is `v: 2`.

### 1.3 `areaKey`

`EG-<governorate code>-<city/district slug>` from a pinned list (`packages/shared/src/geo/egypt-areas.ts`), e.g. `EG-C-nasr-city`. Free-text addresses are matched by alias table (Arabic and English spellings); no match keeps the governorate only (`EG-C`) and logs a miss counter. Never store the street, building or landmark in CI.

### 1.4 Path from the StoreDO to storage

1. **Outbox in the DO.** The domain write and the `ci_outbox` insert run in one `transactionSync` (no event without the outcome, no outcome without the event).
2. **Flush.** A DO alarm (the same one that does the nightly backup, a second timestamp in `alarm()`) drains unsent rows in batches of 100 to Queue `ebda-ci-events` and marks `sentAt`. A throw while enqueuing leaves rows unsent and re-arms the alarm with backoff (fail fast: the row stays visible, never an orphan "sent").
3. **Consumer Worker** (`ebda-ci`, one Worker shared by products): validates the envelope with Zod, drops events whose `eventId` it has already written (a D1 `ci_seen(eventId, day)` table, 7-day TTL sweep), then writes to Analytics Engine and R2.
4. **Dead letters** go to `ebda-ci-events-dlq` and are listed in the super-admin queue page; a replay is one button.

### 1.5 Analytics Engine dataset: `ebda_commerce_outcomes`

For dashboards and quick aggregates only. R2 is the source of truth. No `buyerKey`, no `orderId`.

| Column    | Value                                             |
| --------- | ------------------------------------------------- |
| `index1`  | `storeId` (sampling key; limit 96 bytes)          |
| `blob1`   | `type`                                            |
| `blob2`   | `product`                                         |
| `blob3`   | `carrier` (or empty)                              |
| `blob4`   | `areaKey`                                         |
| `blob5`   | `paymentMethod`                                   |
| `blob6`   | `returnReasonCode` (or empty)                     |
| `blob7`   | `xstore` (`1`/`0`)                                |
| `blob8`   | `v`                                               |
| `double1` | `totalMinor` / `codMinor`                         |
| `double2` | hours (to pick-up, delivery or confirm, per type) |
| `double3` | attempts                                          |
| `double4` | `occurredAt`                                      |

One data point per event, `writeDataPoint` from the consumer (batched; stay under 25 data points per invocation). Retention is Cloudflare's 90 days; AE is sampled at query time, so exact rates come from R2.

### 1.6 R2 layout (bucket `ebda-ci`, private, its own scoped token)

```
outcomes/v1/store=<storeId>/dt=YYYY-MM-DD/<batch ULID>.ndjson.gz   # raw envelopes, one per line; store FIRST so a merchant erase is one prefix
outcomes/v1/store=<storeId>/dt=YYYY-MM-DD/_compacted.ndjson.gz     # daily compaction of the batches
index/buyer/<buyerKey[0:2]>/<buyerKey>.json                         # {"partitions": ["dt=…/store=…/<file>", …]} for erasure
aggregates/v1/<metric>/dt=YYYY-MM-DD.json                           # CI-2 output, never contains buyerKey
manifests/dt=YYYY-MM-DD.json                                        # per-day file list, row counts, sha256 (backup assert)
```

Retention: raw envelopes 24 months (lifecycle rule on `outcomes/`), aggregates indefinitely, AE 90 days. The nightly Mac pull (G8) includes `manifests/` and the last 7 days of `outcomes/`.

### 1.7 Privacy and erasure

- Privacy policy and terms: Ahmad approved the update in advance (register 2026-10-24); the controller drafts, Ahmad signs off on the final text before publishing. Content: hashed buyer key, purpose (improving delivery and fraud signals), merchant opt-in for cross-store use, retention, PDPL 151/2020 rights, Cloudflare as the only processor.
- **Customer erasure:** recompute `buyerKey` from the phone, read `index/buyer/...`, rewrite each listed partition without that buyer's rows, delete the index entry, drop the Store-side `buyerKey` columns. AE holds no buyer key, so nothing to erase there. Aggregates computed earlier stay (they are not personal data after the k-threshold, section 4).
- **Merchant erasure:** delete the `outcomes/v1/store=<storeId>/` prefix (and drop that store from the buyer index entries lazily: an index entry pointing at a missing partition is skipped). Cross-store aggregates already published stay (k-anonymous).
- Tests: one per surface (R2 rewrite drops exactly that buyer's rows and no others; index removed; merchant erase leaves other stores' partitions byte-identical).

### 1.8 CI-1 acceptance (the "done" for before-launch)

- All fields in 1.1 exist in the phase-1 schema with CHECK constraints; the return-reason mapper has a fixture test per carrier (7 carriers).
- Every status write path emits or carries a waiver (guard test green).
- Integration on local workerd: place an order, book, deliver and return a shipment through the DO and read the five events back from the R2 batch and the AE stub; replay the same `eventId` and see one row.
- Backup assert: the `manifests/` row counts equal the NDJSON line counts (rule N11).
- Cost (guess): at 1,000 stores and 50 orders/store/month, about 400 k events/month; Queues and AE writes stay inside the Workers Paid included allowances; R2 storage under 1 GB/year.

## 2. Open decisions (Ahmad / counsel)

1. **Cross-store buyer-level signal.** Showing "this phone returned orders at other stores" is a PDPL risk even when hashed. Default taken in this plan: buyer-level history is shown only inside the store that recorded it; cross-store use is area/carrier level cohorts only. Revisit with counsel before any buyer-level cross-store feature. Cost if wrong: weaker COD risk hints until the decision changes.
2. **`ciSharing` default OFF** (opt-in, as decided). Cost if wrong: smaller cross-store sample, so features reach their thresholds later.
3. **Free-text return reason** is kept 24 months with the envelope. If counsel prefers, drop the raw text after the code is assigned. Cost if wrong: a stale mapper cannot be re-run against history.

## 3. CI-2: internal learning (after launch, a few weeks of data)

### 3.1 Aggregates

Daily Cron (a Workflow when it exceeds one invocation) reads yesterday's compacted partitions and writes `aggregates/v1/<metric>/dt=…json`. First metrics: return rate by (carrier × areaKey), COD confirmation rate by (paymentMethod × areaKey), hours to deliver by (carrier × areaKey), failed-payment rate by provider, onboarding step drop-off by template, cart recovery rate by channel. Each cell carries `n` (events), `stores` (distinct stores, computed from the store dimension then discarded) and the rate; cells below the section 4 thresholds are written as `suppressed: true`.

### 3.2 The AI layer (internal only)

- Inputs are aggregate files only. The runner calls `assertAggregateOnly(payload)` before any model call: it rejects keys named like `buyerKey`, `orderId`, `phone`, `email`, `address`, `name`, any string matching a phone/email pattern, any cell with `suppressed: true` content, and any numeric array longer than 5,000 cells. A failing assertion throws and alerts; it is covered by mutation tests that add each forbidden shape and expect red.
- Preferred model path is Workers AI (stays on Cloudflare). An external model (Gemini Flash Lite `*-latest`) is allowed only behind the same guard and only for aggregate prose ("explain why Aramex returns rose in Giza"). Raw envelopes, `index/buyer/`, and the `ci_outbox` never leave Cloudflare.
- Outputs: `ci_insights` rows in D1 (`id, metric, cohort, finding, evidence JSON, model, createdAt, status new|accepted|dismissed`) and a super-admin "Insights" page. A person accepts an insight before it changes any default (carrier order, onboarding copy, template ranking).
- Cron budget: one daily run, one weekly deep run; no per-event jobs.

### 3.3 CI-2 acceptance

Aggregates reproduce a hand-computed fixture to the cell; the guard rejects every forbidden shape (mutation-checked); a 30-day replay from R2 yields the same aggregates (idempotent); the insights page lists findings with their `n`.

## 4. CI-3: merchant features (advise, never block)

### 4.1 Thresholds (a cell shows a number only if all hold)

| Scope                                          | Minimum sample                                                                               |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Store-only cell (this merchant's own history)  | n >= 30 outcomes in the cell, over >= 14 days                                                |
| Cross-store cell (cohort of `xstore=1` stores) | n >= 100 outcomes AND >= 5 distinct stores AND no store contributes more than 40% of n       |
| A rate shown as "elevated"                     | the Wilson 95% lower bound exceeds the platform baseline for the same carrier/payment method |
| Any hint                                       | the underlying aggregate is under 7 days old                                                 |

Below the threshold the UI shows "not enough data yet", never a guess or a rounded 0%.

### 4.2 Features, in order

1. **COD risk hint** on an order: a band (`typical`, `elevated`) from the area cohort and, inside the same store only, the buyer's own history. Shown on the order page and the WhatsApp confirmation task. It suggests "confirm by phone / ask for InstaPay deposit"; it never holds the order.
2. **Courier suggestion** when booking: ranks the merchant's enabled carriers by delivered-rate and hours-to-deliver for the destination `areaKey` (store-only first, cohort when the threshold holds). The merchant's choice is always one click; the default stays what they last used.
3. **Price and shipping-fee hints**: where COD returns cluster on high shipping fees, suggest a threshold; shown as a suggestion card in the dashboard.

### 4.3 Guard rails

- A kill switch per feature in D1 `feature_flags` and a per-merchant "turn off hints" toggle.
- Every hint shown is logged with its inputs' `n` and the later outcome, so calibration (predicted band versus actual return rate) is a weekly query. A band whose calibration is off by more than 10 points is disabled automatically and alerts.
- A static test asserts that no code path in the checkout, order-create or booking flow reads a CI value to reject, delay or cancel (grep guard on the CI client import list).
- No merchant ever sees another store's identity, an individual buyer from another store, or a phone number from the stream.

### 4.4 CI-3 acceptance

Threshold unit tests on both sides of each boundary; calibration job fixture; the grep guard; a UI test for "not enough data yet"; the feature flag off by default and enabled per store.

## 5. Sequence

| When                                    | What                                                                                                      | Owner                        |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------- |
| With phase 1 (before launch)            | 1.1 fields, 1.2 emit sites, outbox, consumer Worker, AE dataset, R2 bucket, erasure surface, privacy text | migration agent + controller |
| Launch                                  | `ciSharing` question in onboarding; manifests in the nightly Mac pull                                     | controller                   |
| Launch + 3 to 4 weeks                   | CI-2 aggregates and the insights page                                                                     | controller                   |
| Launch + 8 weeks, thresholds permitting | CI-3 features one at a time                                                                               | controller                   |

## 6. What this plan does not do

It does not build any of it (docs only), does not touch the phase-1 schema (the migration agent adds the fields in 1.1), and does not decide the privacy text (Ahmad signs it off).
