---
feature: coupon-validation
updated: 2026-06-09
fixes: H6 (rate-limit + uniform error), PR-#88
---

# UAT: Coupon /validate — Rate Limiting & Error Enumeration

**Reviewer account:** anonymous (public endpoint); store_admin to create test coupons
**Pre-conditions:**

- Test store active with at least one coupon (create one in Admin → Coupons if needed)
- Use a staging/preview environment — never run rate-limit tests against prod
- Have `curl` or a REST client available for rapid-fire testing

---

## Golden path — Valid coupon

1. Create a test coupon in **Admin → Coupons → New Coupon**:
   - Code: `TESTUAT10`
   - Type: Percentage
   - Value: 10%
   - Status: Active
2. From the storefront checkout (or via curl):
   ```bash
   curl -X POST https://<preview-api>/api/v1/public/<storeId>/coupons/validate \
     -H "Content-Type: application/json" \
     -d '{"code":"TESTUAT10","orderTotal":10000}'
   ```
3. Verify: **200 OK** with `{ success: true, data: { coupon: {...}, discount: 1000 } }`

---

## Golden path — Invalid / non-existent coupon

1. Submit the validate endpoint with a code that doesn't exist:
   ```bash
   curl -X POST .../validate -d '{"code":"DOESNOTEXIST"}'
   ```
2. Verify: **400** with body `{ success: false, error: { code: "INVALID_COUPON" } }`

---

## Error enumeration test (no code leakage)

Run three scenarios and verify they all return the SAME error code (`INVALID_COUPON`), not distinct codes:

| Scenario                              | Expected code    |
| ------------------------------------- | ---------------- |
| Code doesn't exist                    | `INVALID_COUPON` |
| Code exists but expired               | `INVALID_COUPON` |
| Code exists but usage limit exhausted | `INVALID_COUPON` |

**To test expired coupon:**

- Create a coupon with `expiresAt` = yesterday
- Submit it → must return `INVALID_COUPON` (not `COUPON_EXPIRED` or `NOT_FOUND`)

**To test exhausted coupon:**

- Create a coupon with `usageLimit: 1`
- Use it once → verify it's marked used
- Try again → must return `INVALID_COUPON`

---

## Rate-limit test

1. Fire 25 rapid requests with random codes:
   ```bash
   for i in $(seq 1 25); do
     curl -s -o /dev/null -w "%{http_code}\n" \
       -X POST .../validate \
       -H "Content-Type: application/json" \
       -d "{\"code\":\"BRUTE$i\"}"
   done
   ```
2. Verify: after ~20 requests, responses become **429 Too Many Requests**
3. Wait 60 seconds → verify requests succeed again (window reset)

---

## Edge cases

- [ ] **Missing code field** — `{}` in body → 400 with code `MISSING_CODE` (not `INVALID_COUPON`)
- [ ] **Empty code string** — `{"code":""}` → 400 (same as missing)
- [ ] **Min order not met** — valid coupon with minOrderAmount=10000, send orderTotal=5000 → 400 `MIN_ORDER_NOT_MET` (this is a legitimate distinct error — not covered by the anti-enumeration rule)
- [ ] **No auth required** — the endpoint is PUBLIC; no Authorization header needed → 200/400 work without auth
- [ ] **Admin-created coupon with uppercase code** — coupon code is stored uppercase; validate with lowercase → should match (schema transforms to uppercase on create and validate)

---

## Pass criteria

- [ ] Non-existent / expired / exhausted coupons all return `INVALID_COUPON` (identical body)
- [ ] Valid coupon returns 200 with correct discount calculation
- [ ] 21st request within a minute returns 429
- [ ] Missing code field returns `MISSING_CODE` 400 (not a 500)
- [ ] No Authorization header required for /validate
