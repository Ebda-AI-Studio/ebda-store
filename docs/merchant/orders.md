# Orders (and the Orders app) — الطلبات (وتطبيق الطلبات)

**Audience:** Store merchants & staff | **التسمية:** تشغيلي — للتاجر والموظفين

---

## Where orders live — أين توجد الطلبات

Manage orders from **Admin → Sales → Orders**, or from the dedicated **Orders app** (an installable, focus-mode app for handling orders on a phone). Both surfaces now show the **same controls** — you can do everything in the Orders app that you can do in the full admin.

أدِر الطلبات من **لوحة التحكم → المبيعات → الطلبات**، أو من **تطبيق الطلبات** المخصص (تطبيق قابل للتثبيت لإدارة الطلبات من الهاتف). كلا الواجهتين تعرض **نفس الأدوات** — يمكنك في تطبيق الطلبات فعل كل ما تفعله في لوحة التحكم الكاملة.

---

## The orders list — قائمة الطلبات

The list supports:

- **Search** — find an order by number, customer, or phone.
- **Date filter** — narrow the list to any time period.
- **Bulk "mark paid"** — select multiple orders and mark them paid in one action (useful for cash-on-delivery batches).

تدعم القائمة:

- **البحث** — عن طلب برقمه أو باسم العميل أو رقمه.
- **تصفية بالتاريخ** — حصر القائمة بأي فترة زمنية.
- **"تعليم كمدفوع" بالجملة** — تحديد عدة طلبات وتعليمها كمدفوعة دفعة واحدة (مفيد لطلبات الدفع عند الاستلام).

---

## On a single order — داخل الطلب الواحد

Open any order to:

- **Change status** — confirmed, shipped, delivered, cancelled.
- **Mark paid** — record payment for cash / manual orders.
- **Payment link** — generate, copy, or re-send a payment link to the customer (uses your store's configured gateway).
- **Refund** — issue a refund on a paid order.
- **Refresh payment / refund status** — re-check the latest state with the payment gateway.
- **Invoice** — view the invoice or email it to the customer.
- **Activity timeline** — a chronological log of everything that happened to the order.

افتح أي طلب لـ:

- **تغيير الحالة** — مؤكد، مشحون، مُسلَّم، ملغي.
- **تعليمه كمدفوع** — لتسجيل الدفع للطلبات النقدية/اليدوية.
- **رابط الدفع** — إنشاء أو نسخ أو إعادة إرسال رابط دفع للعميل (عبر بوابتك المُعدّة).
- **استرداد** — إصدار استرداد لطلب مدفوع.
- **تحديث حالة الدفع/الاسترداد** — إعادة التحقق من آخر حالة لدى بوابة الدفع.
- **الفاتورة** — عرض الفاتورة أو إرسالها بالبريد للعميل.
- **سجل النشاط** — سجل زمني لكل ما جرى على الطلب.

---

## Staff access — وصول الموظفين

Staff members you've granted order permissions can view and manage the store's orders — from the full admin or the Orders app — without seeing the rest of your store settings.

يستطيع الموظفون الذين منحتهم صلاحيات الطلبات عرض وإدارة طلبات المتجر — من لوحة التحكم الكاملة أو من تطبيق الطلبات — دون الوصول إلى بقية إعدادات متجرك.

---

## Payment alerts & auto-cancel — تنبيهات الدفع والإلغاء التلقائي

The platform watches the payment state of online orders for you:

- **Payment received** — you're alerted the moment a pending online order is paid, including when a customer pays a re-sent payment link.
- **Payment pending — follow up** — if an online order stays unpaid too long, you get a one-time reminder to follow up. Cash-on-delivery orders never trigger this.
- **No false "refund issued"** — cancelling an order that was never paid restores its stock but does **not** tell the customer a refund happened. A refund notice only goes out for orders that were actually paid.
- **Auto-cancel unpaid orders** — online orders left unpaid past the allowed window are cancelled automatically; the customer gets the standard cancellation notice, and no refund is attempted because nothing was charged.

تراقب المنصة حالة الدفع للطلبات الإلكترونية نيابةً عنك:

- **تم استلام الدفع** — يصلك تنبيه فور دفع طلب إلكتروني معلّق، بما في ذلك عند دفع العميل لرابط دفع أُعيد إرساله.
- **الدفع معلّق — للمتابعة** — إذا بقي طلب إلكتروني غير مدفوع مدة طويلة، يصلك تذكير واحد للمتابعة. طلبات الدفع عند الاستلام لا تُطلق هذا التنبيه.
- **لا "استرداد" زائف** — إلغاء طلب لم يُدفع أصلًا يُعيد مخزونه لكنه **لا** يُبلغ العميل بحدوث استرداد. إشعار الاسترداد يُرسل فقط للطلبات المدفوعة فعلًا.
- **إلغاء تلقائي للطلبات غير المدفوعة** — الطلبات الإلكترونية التي تبقى دون دفع بعد المهلة تُلغى تلقائيًا؛ يصل العميل إشعار الإلغاء المعتاد دون محاولة استرداد لأنه لم يُدفع شيء.

> The exact timing of these alerts and the auto-cancel window are set by Force AI for your deployment. Ask your account manager if you'd like them adjusted.
> توقيت هذه التنبيهات ومهلة الإلغاء التلقائي يضبطها فريق Force AI لمتجرك. تواصل مع مدير حسابك لتعديلها.

---

## Related — ذات صلة

- [Delivery Areas & Fees — مناطق التوصيل والرسوم](./shipping-areas.md)
- [Payment Provider Setup — إعداد بوابات الدفع](./payment-providers.md)
