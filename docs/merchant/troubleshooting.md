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

- **Default Force AI Store domain (`store.forcemediakw.com/<slug>`)**: should always show the padlock. If not, this is a Force AI Store bug — WhatsApp support immediately.
- **Custom domain (`yourstore.com`)**: certificate auto-issues within 1-5 minutes after DNS verification. If still showing after 30 minutes, see [custom-domain.md](./custom-domain.md#common-issues) — common cause is a CAA DNS record blocking Let's Encrypt.

---

## Order issues

### A new order didn't trigger a notification — طلب جديد ولم تصلني تنبيه

Check in order:

1. **Email notification**: check spam folder. Confirm your notification email in **Admin → Settings → Notifications**.
2. **Push notification**: did you install Force AI Store admin as a PWA + grant notification permission? If you cleared browser data, the permission is revoked — re-grant.
3. **Telegram bot**: only the Force Media operator account gets platform-level Telegram alerts. Merchant-level push goes via email + admin PWA push.

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

Force AI Store sessions last 30 days. If you're logged out earlier:

- Did you switch networks (Wi-Fi → mobile data)? Cross-origin cookie behavior on iOS Safari occasionally drops the auth cookie.
- Did you clear cookies? That resets all sessions.
- Are you using a browser extension that blocks cookies (uBlock Origin, etc.)? Whitelist `app.forcemediakw.com`.

الجلسة تستمر 30 يومًا. إذا انقطعت أسرع: تأكد ما غيّرت شبكة، ما فعّلت إضافة تحظر الكوكيز، وأن الكوكيز ما اتمسحت.

### "Validation failed" when saving a product — رسالة خطأ عند حفظ المنتج

Force AI Store enforces strict validation. The error message tells you which field — common ones:

- **Name (Arabic) is required**: even if you only sell to English-speakers, Arabic name is required for SEO + Search
- **Price must be > 0**: free products → use a coupon for 100% discount instead
- **At least one image**: drag-drop one before saving
- **SKU must be unique**: if you copy-pasted from another product, the SKU got duplicated

---

## WhatsApp integration issues — مشاكل تكامل واتساب

### Customer email shows as `wa-...@placeholder.forcestore.kw` — البريد يظهر كعنوان وهمي

This is expected behavior for orders placed via WhatsApp DM ordering. When a customer
orders through WhatsApp, the platform creates a customer account using a synthetic
placeholder email (`wa-<phone>@placeholder.forcestore.kw`) because the customer
never provided a real email address.

- The placeholder email is **hidden** on the order detail page in Admin — you won't
  see it there.
- It will appear if you export orders as XLSX or query the customer list.
- No action needed. The customer receives all order updates via WhatsApp, not email.

البريد الوهمي يظهر فقط في تصدير الطلبات أو قائمة العملاء. الإشعارات تصل للعميل عبر واتساب تلقائيًا.

### Order list shows wrong payment link or re-issues a new link — الطلب يعرض رابط دفع خاطئ

For **WhatsApp-origin orders** (placed via the ordering bot), if a payment link
was already generated for the order, the order detail **action bar** now shows
the existing MyFatoorah URL inline with **Copy** and **Open** buttons — no new
link is generated.

If you see a new link being generated instead:

1. Check that the order's `externalPaymentUrl` field is populated (visible in the
   API response or payment logs tab on the order detail page)
2. If the field is empty, the existing-link surface won't trigger — the modal
   falls back to generating a fresh one, which is the correct behavior for orders
   that never had a link

للطلبات القادمة من واتساب: إن وُجد رابط دفع مسبق، يظهر مباشرة بأزرار «نسخ» و«فتح». إن لم يكن الحقل `externalPaymentUrl` محدودًا، يُنشأ رابط جديد تلقائيًا.

### Cart abandoned WhatsApp reminders not firing — تذكيرات السلة المتروكة لا ترسل

Check all of the following:

1. **WBS connected** — go to Settings → WhatsApp Integration → Connection and confirm status shows "Connected"
2. **`cartAbandoned` template approved** — in Settings → WhatsApp Integration → Templates, find `cart_abandoned` (or its current version if reset), confirm Meta status is "Approved"
3. **Abandoned cart feature enabled** — Settings → Feature Toggles → Abandoned Cart Recovery should be ON
4. **3-step cadence timing** — reminders fire at 1h, 4h, and 24h after the cart was last updated. If the cart was created less than 1h ago, no reminder has fired yet
5. **WhatsApp-origin carts included** — as of Phase 8, both website carts AND WhatsApp DM carts are swept. If a customer started via WhatsApp DM, their cart is also eligible for the reminder cadence

تحقّق: اتصال WBS فعّال، قالب `cart_abandoned` معتمد، ميزة استرداد السلة مفعّلة في الإعدادات، التوقيت (1h/4h/24h من آخر تحديث للسلة).

### Connected to WBS but seeing 0 approved templates — متصل لكن لا توجد قوالب معتمدة

1. Open the WhatsApp Business Platform admin dashboard (ws.forcemediakw.com)
2. Go to your template list — check the status column on Meta for each template
3. Templates may have been rejected by Meta. Use the **Reset to Draft** button on any rejected template to automatically rename it (e.g., `order_paid_v2`) and resubmit for approval
4. After approval, template dropdowns in Force AI Store admin resolve the new version automatically — you do not need to re-select them
5. If the template list is **still empty** after your templates are approved: disconnect then reconnect the WBS integration (Settings → WhatsApp Integration → Connection → Disconnect, then reconnect with the same API key). This triggers a fresh metadata fetch from WBS which unions the FWB-side approved templates with the live list.

تحقّق من حالة القوالب في لوحة WBS وMeta. القوالب المرفوضة يمكن إعادة تقديمها بزر «Reset to Draft» — القوائم المنسدلة في المتجر تتعرّف على الإصدار الجديد تلقائيًا. إن استمرت القائمة فارغة بعد الاعتماد، افصل ثم أعد الاتصال لإجراء تحديث للبيانات الوصفية.

### Bot says "tap a product please" to customers instead of understanding natural language — البوت لا يفهم الطلبات الطبيعية

This means the Gemini AI classifier is not running — the bot is in legacy keyword mode.

**Root cause:** `GEMINI_API_KEY` is missing from the WBS Railway environment.

**Fix (admin-only, contact Force AI):**

1. Log into Railway → `whatsapp-broadcaster` service → Variables
2. Confirm `GEMINI_API_KEY` is set to a valid Google AI Studio key
3. Redeploy the service
4. Test by DMing a natural-language phrase like "أريد أطلب قهوة" — bot should now classify and respond intelligently

بدون `GEMINI_API_KEY` في Railway، البوت يرجع لوضع الكلمات المفتاحية. تواصل مع فريق Force AI لإضافة المفتاح.

### Customer DM ordering toggle not showing in admin — زر تفعيل الطلبات لا يظهر

The toggle only appears after a successful WBS connection. Check the **Settings card status chip**:

- If it shows "Not connected" → complete the WBS connection first (see Quickstart step 9)
- If it shows "Connected" but the toggle still doesn't appear → hard-refresh the admin (Cmd+Shift+R) or WhatsApp Force AI support with your store slug

### Payment link returns 400 error — رابط الدفع يرجع خطأ 400

Two common causes:

1. **No payment provider configured** — check **Admin → Settings → Payment Settings** and confirm at least one provider is enabled and has valid credentials
2. **`paymentLink` template not approved** — the payment link sends a WhatsApp template to the customer after link generation. Confirm the `paymentLink` template is approved in your WBS template list. If rejected, use **Reset to Draft** and resubmit.

### Templates rejected by Meta — Meta رفضت القوالب

1. Go to **Admin → Settings → WhatsApp Integration → Templates**
2. Find the rejected template (shown with a red status badge)
3. Click **Reset to Draft** — this renames the template (e.g., `order_paid` → `order_paid_v2`) and sets it back to draft for resubmission
4. Meta typically reviews templates within 1–24 hours
5. Once approved, all admin dropdowns that use this template auto-update to the new version — no manual re-selection needed

If the same template gets rejected repeatedly, review Meta's [Message Template Guidelines](https://business.facebook.com/business/help/2055875911147364) for the specific rejection reason shown in Meta Business Manager.

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
| **P3 — feature request / minor bug**  | Cosmetic issues, "it'd be nice if..."                                                   | Email contact@forcemediakw.com                   |

اتصل بالدعم بحسب الأولوية: P0 (الموقع معطّل) فوري عبر واتساب، P1 (خلل جزئي) واتساب مع تفاصيل، P2 (مشكلة محدّدة) واتساب مع رقم الطلب، P3 (ميزة أو خلل بسيط) إيميل.

## What we need from you when reporting

To diagnose quickly:

1. **Exact URL** where the issue happens (copy from address bar)
2. **Screenshot** showing the error or unexpected behavior
3. **Time + date** the issue started (Kuwait time)
4. **Browser + device** (Chrome on iPhone 14, Safari on iPad, etc.)
5. **Reproducible steps** if possible ("I clicked X, then Y, then Z and saw...")
6. **Order/product/customer ID** if the issue is about a specific entity

عند الإبلاغ عن مشكلة، أرسل: الرابط بالضبط، لقطة الشاشة، وقت بدء المشكلة، نوع المتصفّح/الجهاز، خطوات إعادة المشكلة، رقم الطلب أو المنتج لو المشكلة محدّدة.
