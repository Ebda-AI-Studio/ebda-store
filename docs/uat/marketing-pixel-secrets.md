---
feature: marketing-pixel-secrets
updated: 2026-06-09
fixes: H4 (pixel token exposure + masked resubmit), PR-#89
---

# UAT: Marketing Pixels — Secret Masking & Safe Resubmit

**Reviewer account:** store_admin with a real (or fake test) Meta CAPI access token configured
**Pre-conditions:**

- Store has Marketing Pixels configured: Admin → Settings → Marketing Pixels
- Meta CAPI access token set (any non-empty string for UAT; use a fake one in staging)
- Browser DevTools open (Network tab + Elements tab)

---

## Golden path — Masked display

1. Navigate to **Admin → Settings → Marketing Pixels** (or Integrations → Pixels)
2. Observe the **Meta CAPI Access Token** field
3. Verify: the field shows a masked value (e.g. `EAAB****cdef`) — NOT the full token
4. Open **DevTools → Network** → find the GET request for marketing-pixels data
5. Inspect the response JSON → verify `accessToken` field contains `****` (masked), NOT the real secret
6. Open **DevTools → Elements** → inspect the input field value → must not contain the real token

---

## Golden path — Save without changing the token (masked resubmit safe)

1. On the Marketing Pixels page, do NOT touch the access token field
2. Update only the **Pixel ID** (e.g. add a character and revert) to trigger a "dirty" state
3. Click **Save**
4. Verify: 200 OK, no error
5. Navigate away and return → the access token field still shows a masked value (not `****` literal stored)
6. **Verify in DB or via API**: the real stored token has NOT been replaced with `****`
   - If you have DB access: `SELECT "marketingPixels" FROM stores WHERE id = '<id>'`
   - The `accessToken` value should be the original real token, not `****...`

---

## Golden path — Update the token (real new value)

1. Clear the masked token field completely
2. Enter a new token value: `NEWTESTTOKEN_abc123`
3. Click Save → 200 OK
4. Verify: GET response now shows a new masked version of the new token (e.g. `NEWT****3`)
5. Verify the real new token is stored (DB check or API behavior confirms it's functional)

---

## Edge cases

- [ ] **Screenshot / screen recording** — the token field should be `type="password"` or visually masked so it doesn't appear in screenshots (check the HTML `input` element type)
- [ ] **Copy-paste from the field** — if the field is password type, copy → should paste `****xxxx` (the mask), not the real value
- [ ] **Two platforms (Meta + TikTok)** — both tokens masked independently; saving one does not affect the other
- [ ] **Token cleared intentionally** — clear the field and save → the token is removed from storage (not replaced with empty string in an undefined state)
- [ ] **Pixel ID saved alongside masked token** — update only the Pixel ID → save → verify Pixel ID updated, token unchanged

---

## Pass criteria

- [ ] GET response `accessToken` always contains `****` (never the real value)
- [ ] Input field on the page never shows the full token
- [ ] Saving with a masked (untouched) token field does NOT overwrite the stored secret
- [ ] Saving with a new explicit token value DOES update the stored secret
- [ ] TikTok and Meta tokens are masked independently
