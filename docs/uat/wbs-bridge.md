---
feature: wbs-bridge
updated: 2026-05-24
---

# UAT: WhatsApp (WBS) Bridge Integration

**Reviewer account:** see 1Password vault entry `wbs-bridge-uat`  
(store_admin on the test store + WBS account with at least one approved template)  
**Pre-conditions:**

- WBS (WhatsApp Bulk Sender) staging instance running at `backend.forcemediakw.com` or a staging equivalent
- A valid WBS API key for the test WBS account (generated in WBS dashboard)
- At least 1 approved WhatsApp template in WBS (e.g. `force_order_shipped_v1` or equivalent)
- Test store in FWB has NO existing WBS connection (to test the connect flow)
- A test phone number that can receive WhatsApp messages (real phone; test environment)
- Preview/staging admin; **never connect WBS bridge against prod FWB + prod WBS simultaneously**

**Browser matrix:** Chrome latest · Safari latest · mobile Safari iOS 17+

---

## Golden path — Connect by key

1. Admin → Settings → **WhatsApp** card
2. Verify card shows connection status: "Not connected" (or disconnected chip)
3. Click **Connect WhatsApp** (or navigate to the WhatsApp settings tab)
4. Navigate to WBS dashboard → Account Settings → copy **API key**
5. Paste WBS API key into FWB WhatsApp settings field
6. Click **Connect**
7. Verify metadata syncs within 3s: WBS account name, phone number, and available templates appear in FWB
8. Verify connection status chip on Settings card updates to "Connected" (or green indicator)
9. Navigate away and back to WhatsApp settings → connection persists (not re-prompted)

## Golden path — Template list sync

10. In FWB WhatsApp settings → **Templates** tab
11. Verify the approved template(s) from WBS appear with correct name and status (`APPROVED`)
12. Verify version-agnostic match: if template was recently renamed (e.g. `_v1` → `_v2`), the latest version appears and is selectable

## Golden path — Send test order template

13. Admin → Orders → open any order in `paid` or `shipped` status
14. Click **Send WhatsApp Notification** (or the WhatsApp template send button)
15. Select the order-shipped template
16. Verify template variables are pre-filled: customer name, order number, tracking (if available)
17. Click **Send**
18. Verify success toast: "Message sent" within 3s
19. Verify the test phone receives the WhatsApp template message within 60s
20. In WBS dashboard → sent messages log → verify delivery status = `delivered` or `read`

---

## Edge cases

- [ ] **Invalid API key** — paste a garbage key → FWB shows "Connection failed: invalid key" error inline; no crash; no partial state saved
- [ ] **WBS disconnected mid-session** — after connecting, revoke the API key in WBS → FWB shows a "connection lost" error on next template fetch; re-connect flow is accessible
- [ ] **Template version bump** — if WBS renames template to `_v2` after FWB synced `_v1` → re-sync fetches latest version; `_v2` appears in FWB dropdown; `_v1` is no longer shown as stale
- [ ] **Duplicate send** — click "Send" twice rapidly → only one message dispatched (idempotent or re-entry guard); no duplicate WhatsApp delivery
- [ ] **Arabic locale** — WhatsApp settings tab in AR locale → RTL layout; all labels and status chips in Arabic
- [ ] **Status chip discoverability** — Settings overview card shows WhatsApp status chip without navigating to the tab (per discoverability-status-chip pattern); chip reflects live connected/disconnected state

---

## Sign-off

| Role         | Name             | Date         | Notes                                      |
| ------------ | ---------------- | ------------ | ------------------------------------------ |
| Engineer     | \***\*\_\_\*\*** | **\_\_\_\_** |                                            |
| Merchant rep | \***\*\_\_\*\*** | **\_\_\_\_** | only required before first merchant launch |
