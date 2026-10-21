# UAT: Low-Stock Alert Email

**Feature:** `inventory.stock_alerts` (Professional+)
**Inngest job:** `stock-low-stock-alert-cron` (every 6 h) + on-demand event `stock/low-stock-scan-requested`
**Owner:** Store owner receives a branded bilingual digest email when products drop below their configured `lowStockThreshold`.

---

## Prerequisites

- Store is on the Professional (or Enterprise / w_enterprise) plan, OR has a `StoreFeature` override enabling `inventory.stock_alerts`.
- At least one product has `trackInventory = true` and a non-zero `lowStockThreshold`.
- Redis is running (sentinels are stored in Redis; feature is fail-open when Redis is unavailable — it over-alerts rather than going silent).

---

## Golden Path

### 1. Trigger a low-stock condition

1. In Admin → Products, set a product's **inventory** to a value > 0 and ≤ **lowStockThreshold**.
   e.g. inventory = 3, threshold = 10.

2. Fire the on-demand event (via Inngest dashboard or test route):

   ```
   POST /api/v1/inngest
   Event: stock/low-stock-scan-requested
   Data: { storeId: "<id>", requestedBy: "uat-test" }
   ```

3. **Expected:** The store owner receives one branded email with a table listing the affected product(s), their current stock count (in red), and their threshold.

4. Verify in Inngest dashboard: function `stock-low-stock-alert-on-demand` ran, emitted 1 email.

### 2. Re-trigger without restocking (dedup check)

1. Fire the on-demand event a second time (same store, same product still below threshold).
2. **Expected:** No email sent. The Inngest run returns `{ alerted: 0, skipped: 1, emailed: false }`.
3. Redis sentinel key `low-stock-alerted:<storeId>:<productId>` exists (verify via `redis-cli get <key>`).

### 3. Restock above threshold → sentinel cleared

1. Set the product's inventory above the threshold (e.g. inventory = 50, threshold = 10).
2. Fire the on-demand event.
3. **Expected:** No email sent (product is healthy). `clearedCount` ≥ 1.
4. Redis sentinel key is gone (`redis-cli get <key>` returns nil).

### 4. Re-drop after restock → re-alerts

1. Set inventory back to 3 (below threshold again).
2. Fire the on-demand event.
3. **Expected:** Email fires again. Product appears in the digest.

---

## Edge Cases

| Scenario                                                 | Expected behaviour                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `inventory = 0` (out-of-stock)                           | NOT in digest. Out-of-stock is a different state.                                     |
| `inventory = lowStockThreshold` (exactly at boundary)    | IN digest (≤ threshold inclusive).                                                    |
| `inventory > lowStockThreshold`                          | NOT in digest.                                                                        |
| Feature `inventory.stock_alerts` disabled (Starter plan) | Scan skipped entirely. No email. Inngest returns `{ skipped: true }`.                 |
| Store has no owner email                                 | Scan runs, digest built, log warns "no recipient email", email NOT sent.              |
| Redis unavailable                                        | Sentinel read fails-open (returns false) → product is alerted on every run. No crash. |
| `trackInventory = false` on product                      | Product excluded from scan query.                                                     |
| Product `deletedAt != null`                              | Product excluded from scan query.                                                     |
| Product `status != 'active'`                             | Product excluded from scan query.                                                     |
| `lowStockThreshold = 0`                                  | Product excluded from scan query (`threshold > 0` filter).                            |
| Multiple products low at same time                       | ONE digest email listing all low-stock products (not one email per product).          |
| AR store (`settings.defaultLanguage = 'ar'`)             | Subject and body rendered in Arabic; RTL shell; uses `nameAr` if available.           |
| `nameAr` null on an AR store                             | Falls back to `name` (English) in the AR body.                                        |

---

## Email Appearance Checklist

- [ ] Branded header (logo if set, otherwise store name) ✓
- [ ] Brand color applied to ribbon, button, links ✓
- [ ] Table: product name / current stock (red) / threshold columns ✓
- [ ] "Manage Inventory" CTA button links to `/inventory` in the admin ✓
- [ ] Footer: store name, address, phone, powered by Ebda AI Studio ✓
- [ ] No raw HTML tags visible ✓
- [ ] No XSS: a product named `<script>alert(1)</script>` renders as escaped text ✓

---

## Cron Schedule

The cron fires at `0 */6 * * *` (every 6 hours: 00:00, 06:00, 12:00, 18:00 UTC).
Egypt time (UTC+3): 03:00, 09:00, 15:00, 21:00.
Merchants can expect at most a 6-hour delay between a stock drop and the alert email, and only on the FIRST drop (subsequent runs are silent via sentinel dedup).
