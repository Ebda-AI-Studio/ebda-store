# Payment Provider Setup — إعداد بوابات الدفع

Ebda Store integrates with 4 Egypt-based payment providers + Cash on Delivery. You only need **one** provider account to accept online payments; multiple providers give your customers more checkout options.

تتكامل Ebda Store مع 4 بوابات دفع كويتية + الدفع عند الاستلام. تحتاج حساب مع بوابة واحدة فقط — الباقي اختياري.

## Comparison

| Provider         | Cards | KNET (K-Net) | Apple Pay | Setup difficulty  | Fees (approx)                 |
| ---------------- | ----- | ------------ | --------- | ----------------- | ----------------------------- |
| **Tap Payments** | ✅    | ✅           | ✅        | Easy — 15 min     | 2.85% + 75 fils per txn       |
| **MyFatoorah**   | ✅    | ✅           | ✅        | Easy — 15 min     | 2.5% + 100 fils per txn       |
| **Hesabe**       | ✅    | ✅           | ❌        | Medium — 30 min   | Custom contract               |
| **UPayments**    | ✅    | ✅           | ✅        | Easy — 15 min     | 2.65% + 90 fils per txn       |
| **COD**          | n/a   | n/a          | n/a       | 0 min — toggle on | 0 (charge fixed handling fee) |

Fees are approximate per public pricing pages 2026-05; confirm with each provider when you sign up.

## Universal webhook URL

**All four providers use the SAME webhook URL on Ebda Store:**

```
https://api.ebda.app/api/v1/webhooks/payment/<provider>
```

(`api.ebda.app` is the new primary API domain; `api.ebda.app` continues to be served during migration — both work.)

Where `<provider>` is one of: `tap`, `myfatoorah`, `hesabe`, `upayments`.

Ebda Store displays the exact URL inside each provider's panel in **Admin → Settings → Payment Settings** with a one-click Copy button — you don't need to construct it manually.

كل بوابات الدفع تستخدم نفس صيغة الـ webhook URL — تجده مع زر نسخ بجانب كل مزوّد في لوحة إعدادات الدفع.

---

## Tap Payments setup

1. Sign up at <https://www.tap.company/kw/en> (Egypt business registration + CR required)
2. Once approved, log into <https://dashboard.tap.company>
3. Settings → **API Keys** → create a **Live Secret Key** (starts with `sk_live_`)
4. Settings → **Webhooks** → Add new webhook:
   - URL: `https://api.ebda.app/api/v1/webhooks/payment/tap`
   - Events: `charge.created`, `charge.updated`, `charge.captured`, `charge.failed`, `charge.refunded`
   - Save → Tap shows the webhook secret — **copy it now, shown once**
5. In Ebda Store: **Admin → Settings → Payment Settings → Tap**:
   - Toggle: ON
   - API Key: paste the secret key from step 3
   - Webhook Secret: paste the webhook secret from step 4
   - Test Mode: OFF for live, ON while testing
   - **Save**
6. Test: make a real ~1 EGP purchase from your storefront — confirm the order shows `payment_status=paid` in **Admin → Orders**

---

## MyFatoorah setup

1. Sign up at <https://portal.myfatoorah.com> (Egypt business registration required)
2. Once approved, navigate to **Developer → API Keys**
3. Generate a **Live Token** (long string, often base64-looking)
4. Navigate to **Notifications → Web Hooks → Add**:
   - URL: `https://api.ebda.app/api/v1/webhooks/payment/myfatoorah`
   - Secret: click Generate → copy the secret
   - Events: tick all payment events (Paid, Failed, Refunded, etc.)
5. In Ebda Store: **Admin → Settings → Payment Settings → MyFatoorah**:
   - Toggle: ON
   - API Key: paste the live token
   - Webhook Secret: paste the webhook secret
   - Test Mode: OFF for live
   - **Save**
6. Test: make a real purchase, confirm in **Admin → Orders**

---

## Hesabe setup

Hesabe is contract-based — you'll receive credentials by email from your account manager rather than self-serve.

1. Email <sales@hesabe.com> to open a merchant account
2. After signing the contract, you receive:
   - Merchant Code
   - API Key
   - Webhook Secret
3. In Ebda Store: **Admin → Settings → Payment Settings → Hesabe**:
   - Toggle: ON
   - Merchant ID: paste the merchant code
   - API Key: paste the key
   - Webhook Secret: paste the secret
   - Test Mode: OFF for live
   - **Save**
4. Email Hesabe support to register the webhook URL on their side:
   `https://api.ebda.app/api/v1/webhooks/payment/hesabe`

---

## UPayments setup

1. Sign up at <https://www.upayments.com> (Egypt business registration)
2. Once approved, log into the merchant dashboard
3. **Settings → API Credentials**:
   - Copy the **Live API Key** (starts with `sk_live_`)
4. **Settings → Webhooks**:
   - URL: `https://api.ebda.app/api/v1/webhooks/payment/upayments`
   - Secret: copy
5. In Ebda Store: **Admin → Settings → Payment Settings → UPayments**:
   - Toggle: ON
   - API Key + Webhook Secret: paste
   - Test Mode: OFF for live
   - **Save**

---

## Which key is saved? — أي مفتاح محفوظ؟

Saved keys are stored encrypted and are never shown in full. Under the **API Key** and **Merchant ID** fields the panel shows the last 4 characters of the saved value — e.g. **Saved: \*\*\*\*a1b2** — so you can match it against the key in your provider's dashboard. A key saved before this was added shows **Saved: \*\*\*\*** with a note to re-save it: paste the key again and **Save**, and its last 4 characters appear.

المفاتيح المحفوظة مشفّرة ولا تُعرض كاملة أبداً. تحت حقلي **API Key** و **Merchant ID** تظهر آخر 4 أحرف من القيمة المحفوظة — مثلاً **المحفوظ: \*\*\*\*a1b2** — لتطابقها مع المفتاح في لوحة مزوّد الدفع. المفتاح المحفوظ قبل هذه الميزة يظهر **المحفوظ: \*\*\*\*** مع تنبيه بإعادة حفظه: الصق المفتاح مرة أخرى واضغط **حفظ** لتظهر آخر 4 أحرف.

---

## Cash on Delivery (COD)

No external account needed.

1. **Admin → Settings → Payment Settings → Cash on Delivery**
2. Toggle: ON
3. Display Name: e.g. "Cash on Delivery" / "الدفع عند الاستلام"
4. Fixed fee: optional (e.g. 1 EGP handling fee added to every COD order)
5. **Save**

COD orders are marked `payment_status=cod_pending` until you mark them paid in **Admin → Orders → [order] → Mark as Paid** after collecting cash on delivery.

طلبات الدفع عند الاستلام تبقى بحالة `cod_pending` لحين استلام النقد ثم تضغط «تم الدفع» من صفحة الطلب.

---

## Test mode vs live mode

Every provider has a "test mode" that uses fake credit cards (e.g. `4242 4242 4242 4242` for Tap, `5123 4500 0000 0008` for MyFatoorah). Test transactions don't bill real money.

**Always test in test mode first**, then switch to live mode only after:

1. A test order goes through end-to-end (order created in admin → payment status updates to `paid` → success page shows)
2. You've configured your shipping zones
3. You've set up your store profile fully

كل مزوّد له «وضع اختبار» لبطاقات وهمية بدون مدفوعات حقيقية. اختبر دائمًا قبل التحويل للوضع المباشر.

---

## Multi-provider strategy

If you enable multiple providers, your customer sees them as separate options at checkout. You can:

- Set one as **default** (selected first at checkout)
- Reorder them with the up/down arrows
- Set a different fixed fee per provider (e.g. UPayments has lower fees → no extra fee; Hesabe contract has higher fees → pass 1 EGP to customer)

لو فعّلت أكثر من بوابة، اختر واحدة افتراضية وأعد ترتيب الباقي. تقدر تضيف رسوم ثابتة مختلفة لكل بوابة.

---

## WhatsApp payment links

Merchant-initiated payment links (sent to customers via WhatsApp) use **the same provider configuration** as your storefront checkout. There is no separate payment link gateway — the link generates a checkout URL through whichever provider you have active.

To generate a payment link from the admin:

1. **Admin → Orders → [any order] → Payment Link** (or create a new manual order)
2. Use the **typeahead product picker** to search your catalog and add products, OR enter a **custom amount** for a deposit or service fee
3. Click **Generate Link** → copy and paste into WhatsApp
4. The customer taps the link → lands on your Ebda Store checkout with the cart pre-filled
5. Pays via their preferred method (KNET, Apple Pay, cards — whatever your gateway supports)

If a payment link was already generated for an order, the **Copy** and **Open** buttons appear inline — you do not need to generate a new one.

لإنشاء رابط دفع من لوحة الطلبات: افتح الطلب ← Payment Link ← ابحث عن المنتج بالكتابة أو أدخل مبلغًا مخصصًا ← انسخ الرابط وأرسله للعميل على واتساب. البوابة المُستخدمة هي نفس بوابة متجرك المفعّلة.

---

## Multi-tenant safety (technical)

You may wonder: "if every store uses the same webhook URL, can other merchants see my payment events?"

**No.** Each store has its own per-tenant webhook secret. When a payment provider sends a webhook to `api.ebda.app/api/v1/webhooks/payment/myfatoorah`, Ebda Store:

1. Looks up the transaction ID inside the payload
2. Finds which store's order it belongs to (via the `Order` table)
3. Verifies the HMAC signature using **that specific store's** webhook secret
4. Only then processes the payment — and only against that store's order

A merchant configuring a different store's credentials can't intercept anyone else's payments — the HMAC verification fails and we fire a P0 security alert after 3 such failures in 5 minutes.

سؤال مشروع: «هل تجار آخرون يقدرون يطّلعوا على مدفوعاتي إذا كل المتاجر تستخدم نفس رابط webhook؟» الجواب: لا. كل متجر له «سر webhook» خاص فيه، ولو حاول أحد التلاعب يفشل HMAC ويُرفع إنذار أمني فوريًا.

---

## How a paid order is confirmed (two paths)

Ebda Store confirms an online payment via **two** independent paths, so a single misconfigured webhook can't leave a paid order stuck:

1. **Verify-on-return (primary).** The moment the customer returns to the order-success page after paying, Ebda Store asks the provider directly "is this invoice paid?" and — if yes — marks the order paid and fires all your notifications (email + admin push + WhatsApp). This works even when the provider's webhook isn't configured. The success page then shows the truthful status: **paid**, **confirming…**, or **payment not completed** (with a "Try payment again" button).
2. **Webhook (backup).** If you've pasted the webhook URL into your provider portal, the provider also pushes the status to us. This is the safety net — and it's idempotent with path (1), so the customer/admin never get duplicate notifications.

طريقتان مستقلتان لتأكيد الدفع: (1) **التحقق عند العودة** — بمجرد رجوع العميل لصفحة نجاح الطلب نسأل المزوّد مباشرة إن كان الدفع تمّ، ونؤكد الطلب ونرسل الإشعارات؛ (2) **الويب هوك** كخط احتياطي. الطريقتان لا تُكرّران الإشعارات.

## What if a webhook fails?

With verify-on-return above, a missed webhook usually no longer leaves an order stuck — the success page already confirmed it. If a customer closes the browser at exactly the wrong moment AND the webhook is unconfigured, the order can still sit at `payment_status=pending`. Most providers also retry the webhook automatically for 24h.

If the order is stuck in `pending` for >1 hour:

1. Check the provider's dashboard — was the payment actually completed?
2. If yes: contact the Ebda AI Studio team — we can manually mark the order paid after verifying the transaction ID
3. If no: the payment likely failed silently; ask the customer to try again

لو الطلب بقي في حالة `pending` أكثر من ساعة: تأكد من لوحة المزوّد إذا الدفع تمّ فعلًا، تواصل مع فريق Ebda AI Studio لتعديل الحالة يدويًا بعد التحقّق.
