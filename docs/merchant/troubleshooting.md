# Troubleshooting — حل المشاكل

When something looks wrong, check here first before WhatsApping support. لو ظهرت مشكلة، افحص هذه الصفحة قبل الاتصال بالدعم.

## Storefront issues

### Storefront shows a blank white page — المتجر يظهر صفحة بيضاء

1. Open the URL in an incognito/private browser window to rule out cached state
2. Check <https://stats.uptimerobot.com/23nuarbz3h> — is the platform up?
3. If platform is up but storefront still blank: clear browser cache (Cmd+Shift+R / Ctrl+Shift+R)
4. If still broken: WhatsApp support with a screenshot + the URL

### Changes I saved in Page Builder aren't showing on the storefront — حفظت التغييرات لكنها لا تظهر في الواجهة

There are three distinct root causes for this:

1. **Save confirmation** — if you see the save spinner but no success toast, the save may have failed silently. Check the browser DevTools Network tab for a non-2xx response on the `PUT /stores/.../layout` or `PUT /stores/.../theme` request. If you see a 4xx, contact support with the response body.
2. **Section order** — dragging sections to reorder them in Page Builder saves the order but the storefront renders sections in a fixed sequence in version 1 of the section-order feature. The saved order is not yet honored on the live storefront. Use the visibility toggle to hide sections you don't want instead of relying on order.
3. **Hero banner** — if you edited the legacy Hero page (`/hero`) before 2026-06-09, those fields were only used as a fallback when there were no Page Builder hero slides. After the 2026-06-09 migration, your hero content is in Page Builder slides. Check **Admin → Page Builder → Hero** for your content.

انتظر دقيقتين بعد الحفظ لتحديث الكاش. لو التغييرات لا تزال مفقودة، تحقّق: (1) هل ظهرت رسالة نجاح الحفظ؟ (2) ترتيب الأقسام لا يُطبَّق بعد في الواجهة — استخدم زر الإخفاء بدلًا من الترتيب. (3) إن كنت تحرّر صفحة البانر القديمة `/hero`، اذهب إلى Page Builder → Hero.

### A product I added isn't showing — منتج أضفته لا يظهر

Check in **Admin → Products → [your product]**:

- **Status** is set to `Active` (not `Draft` or `Archived`)
- The product has **at least one image** (storefront hides imageless products)
- The product is **assigned to at least one category** (orphan products don't appear in category browsing)
- The product **stock** is > 0 (or "always in stock" is on)
- If using **variants**: at least one variant has `Active` status

Storefront cache may take up to 2 minutes to refresh after a product save. Wait + reload.

تحقّق من: حالة المنتج `نشط`، وجود صورة، التصنيف مرتبط، الكمية > 0، (لو متعدّد) متغيّر واحد على الأقل نشط. كاش الواجهة يحتاج دقيقتين بعد الحفظ.

### Wrong language showing on the storefront — تظهر لغة خاطئة

The storefront has its own language toggle (top-right corner) independent of the browser. Two reasons for "wrong" language:

- **Customer's last choice**: language persists in a cookie. Customers can switch any time.
- **Your default**: **Admin → Settings → Storefront → Default Language** controls what new visitors see.

اختيار اللغة يُحفظ في cookie للزائر. الافتراضي يُضبط من إعدادات الواجهة.

### Storefront SSL warning / "Not Secure" badge — تحذير شهادة SSL

- **Default Ebda Store domain (`store.ebda.app/<slug>`)**: should always show the padlock. If not, this is a Ebda Store bug — WhatsApp support immediately.
- **Custom domain (`yourstore.com`)**: certificate auto-issues within 1-5 minutes after DNS verification. If still showing after 30 minutes, see [custom-domain.md](./custom-domain.md#common-issues) — common cause is a CAA DNS record blocking Let's Encrypt.

---

## Order issues

### A new order didn't trigger a notification — طلب جديد ولم تصلني تنبيه

Check in order:

1. **Email notification**: check spam folder. Confirm your notification email in **Admin → Settings → Notifications**.
2. **Push notification**: did you install Ebda Store admin as a PWA + grant notification permission? If you cleared browser data, the permission is revoked — re-grant.
3. **Telegram bot**: only the Ebda AI Studio operator account gets platform-level Telegram alerts. Merchant-level push goes via email + admin PWA push.

تحقّق: مجلد السبام، إعدادات إيميل الإشعارات، صلاحية الإشعارات في متصفّحك (لو ثبّت كPWA).

### Order shows `payment_status=pending` for > 1 hour — طلب pending أكثر من ساعة

See [faq.md → A customer says they paid but I see status=pending](./faq.md#a-customer-says-they-paid-but-i-see-statuspending-what-now-).

### Order shows `payment_status=failed` but customer was charged — العميل اتخصم لكن الطلب failed

Rare but possible — usually a payment provider mid-state failure. Recovery:

1. Check the provider's dashboard for the transaction ID (visible in **Admin → Orders → [order] → Payment Logs**)
2. If the charge succeeded at the provider: WhatsApp support with the transaction ID; we can manually flip the order to `paid` after verification
3. If the charge was actually captured then auto-reversed: the customer's bank shows it as a pending hold that clears in 3-7 days — apologize and offer to re-process or refund

---

## Admin dashboard issues

### Admin dashboard is slow — لوحة الإدارة بطيئة

1. Are you on slow Wi-Fi? Run a speed test — admin works fine on 1 Mbps+, but image-heavy pages need more.
2. Hard-refresh (Cmd+Shift+R / Ctrl+Shift+R)
3. Check the developer console (F12 → Network tab) — any red requests? Screenshot + send to support
4. If only specific pages are slow (e.g. Products list with 5000+ items): that's expected; use search/filter instead of scrolling

### Admin keeps logging me out — يطلب تسجيل دخول كل شوي

Ebda Store sessions last 30 days. If you're logged out earlier:

- Did you switch networks (Wi-Fi → mobile data)? Cross-origin cookie behavior on iOS Safari occasionally drops the auth cookie.
- Did you clear cookies? That resets all sessions.
- Are you using a browser extension that blocks cookies (uBlock Origin, etc.)? Whitelist `store.ebda.app`.

الجلسة تستمر 30 يومًا. إذا انقطعت أسرع: تأكد ما غيّرت شبكة، ما فعّلت إضافة تحظر الكوكيز، وأن الكوكيز ما اتمسحت.

### "Validation failed" when saving a product — رسالة خطأ عند حفظ المنتج

Ebda Store enforces strict validation. The error message tells you which field — common ones:

- **Name (Arabic) is required**: even if you only sell to English-speakers, Arabic name is required for SEO + Search
- **Price must be > 0** for an active product or variant (a draft may stay at 0; gold-priced pieces are priced by the gold rate). A coupon needs a value above zero and a percentage below 100%; a free order is not something a coupon can do. Keep a free item as a draft.
- **At least one image**: drag-drop one before saving
- **SKU must be unique**: if you copy-pasted from another product, the SKU got duplicated

---

## DNS / domain issues

### Custom domain verification stuck at "verifying" — التحقّق علق على verifying

See [custom-domain.md → Common issues](./custom-domain.md#common-issues).

### Domain works on desktop but not mobile — يفتح على الكمبيوتر ولا يفتح على الجوال

DNS propagation can take longer on mobile carrier networks. Wait 1 hour. If still broken, the carrier is likely caching an old DNS — usually fixes on its own within 24h or restart phone airplane mode.

DNS قد ينتشر أبطأ على شبكات الجوال — انتظر ساعة، أو فعّل/أوقف وضع الطيران لإعادة فحص DNS.

---

## Payment provider issues

See [faq.md → Payments](./faq.md#payments).

---

## When to escalate to support

| Severity                              | Symptoms                                                                                | Action                                           |
| ------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **P0 — site down**                    | Storefront returns 5xx or won't load at all                                             | WhatsApp immediately + tag the message URGENT    |
| **P1 — degraded**                     | Some features broken (e.g. checkout fails, search returns 0 results, images don't load) | WhatsApp with screenshot + URL + time it started |
| **P2 — issue affecting one merchant** | Specific product / order / category misbehaving                                         | WhatsApp + order ID or product ID                |
| **P3 — feature request / minor bug**  | Cosmetic issues, "it'd be nice if..."                                                   | Email contact@ebda.app                           |

اتصل بالدعم بحسب الأولوية: P0 (الموقع معطّل) فوري عبر واتساب، P1 (خلل جزئي) واتساب مع تفاصيل، P2 (مشكلة محدّدة) واتساب مع رقم الطلب، P3 (ميزة أو خلل بسيط) إيميل.

## What we need from you when reporting

To diagnose quickly:

1. **Exact URL** where the issue happens (copy from address bar)
2. **Screenshot** showing the error or unexpected behavior
3. **Time + date** the issue started (Egypt time)
4. **Browser + device** (Chrome on iPhone 14, Safari on iPad, etc.)
5. **Reproducible steps** if possible ("I clicked X, then Y, then Z and saw...")
6. **Order/product/customer ID** if the issue is about a specific entity

عند الإبلاغ عن مشكلة، أرسل: الرابط بالضبط، لقطة الشاشة، وقت بدء المشكلة، نوع المتصفّح/الجهاز، خطوات إعادة المشكلة، رقم الطلب أو المنتج لو المشكلة محدّدة.
