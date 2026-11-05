# Orders (and the Orders app) — الطلبات (وتطبيق الطلبات)

**Audience:** Store merchants & staff | **التسمية:** تشغيلي — للتاجر والموظفين

---

## Where orders live — أين توجد الطلبات

Manage orders from **Admin → Sales → Orders**, or from the dedicated **Orders app** (an installable, focus-mode app for handling orders on a phone). Both surfaces now show the **same controls** — you can do everything in the Orders app that you can do in the full admin.

أدِر الطلبات من **لوحة التحكم → المبيعات → الطلبات**، أو من **تطبيق الطلبات** المخصص (تطبيق قابل للتثبيت لإدارة الطلبات من الهاتف). كلا الواجهتين تعرض **نفس الأدوات** — يمكنك في تطبيق الطلبات فعل كل ما تفعله في لوحة التحكم الكاملة.

---

## The orders list — قائمة الطلبات

The list supports:

- **Search** — find an order by number, by a registered customer's name, email or phone, or by the name, email or phone a **guest** entered at checkout. It searches **all** your orders, not just the page on screen. Type at least 3 characters for the fast path; shorter searches still work, they just take longer on a large store.
- **Date filter** — narrow the list to any time period. Days are your own calendar days (a Egypt order at 01:00 belongs to that day, not the previous one).
- **Export** — downloads **exactly the filtered list**: the same dates, status and search. The file name carries the date range (e.g. `orders-2026-09-01_to_2026-09-30.xlsx`) and a **Filters** sheet says what was applied.
- **Bulk "mark paid"** — select multiple orders and mark them paid in one action (useful for cash-on-delivery batches).

تدعم القائمة:

- **البحث** — عن طلب برقمه، أو باسم العميل المسجَّل أو بريده أو هاتفه. يبحث في **كل** طلباتك وليس في الصفحة المعروضة فقط.
- **تصفية بالتاريخ** — حصر القائمة بأي فترة زمنية، بأيامك أنت (طلب في مصر الساعة 1 صباحًا يُحسب لذلك اليوم لا لليوم السابق).
- **التصدير** — يُنزّل **القائمة المصفّاة نفسها بالضبط**: نفس التواريخ والحالة والبحث. اسم الملف يحمل الفترة (مثل `orders-2026-09-01_to_2026-09-30.xlsx`) وورقة **Filters** توضح ما طُبّق.
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

> The exact timing of these alerts and the auto-cancel window are set by Ebda AI Studio for your deployment. Ask your account manager if you'd like them adjusted.
> توقيت هذه التنبيهات ومهلة الإلغاء التلقائي يضبطها فريق Ebda AI Studio لمتجرك. تواصل مع مدير حسابك لتعديلها.

---

## Related — ذات صلة

- [Delivery Areas & Fees — مناطق التوصيل والرسوم](./shipping-areas.md)

---

## Refunds in your books — الاسترداد في حساباتك

When accounting is on, every refund is recorded in your ledger the way the money actually moved:

- **Part of an order returned** — the returned items come out of your sales. What the customer got back is recorded where it went: back to their **card / payment gateway**, into their **wallet** (a balance you now owe them), or as **store credit** you handed out yourself (also a balance you owe). The amount recorded is the amount actually refunded.
- **Order paid partly from the wallet** — refunding part of it to the "original payment method" sends it back the same way it was paid: the wallet's share to the wallet, the rest to the card. The confirmation shows both amounts before you send anything.
- **Order paid from the wallet** — the wallet part is recorded as settling the balance you owed the customer (account 2150), the rest as cash or card as usual. Credits you give, take back or write off are recorded on the same account; see [Customer wallet and store credit](/en/customer-wallet-and-store-credit/).
- **Partial refund without a return** (for example, one you made in your payment provider's dashboard, or a partial amount from the order page) — recorded as a refund of revenue for exactly that amount. No stock moves. The same refund is never recorded twice, however many times the provider reports it.

عندما تكون المحاسبة مفعّلة، يُسجَّل كل استرداد في دفاترك بالطريقة التي تحرّك بها المال فعلًا:

- **إرجاع جزء من الطلب** — تُخصم الأصناف المرتجعة من مبيعاتك. ويُسجَّل ما استرده العميل حيث ذهب: إلى **بطاقته / بوابة الدفع**، أو إلى **محفظته** (رصيد أصبحت مدينًا له به)، أو كـ**رصيد متجر** تمنحه بنفسك (رصيد مستحق أيضًا). والمبلغ المسجّل هو المبلغ المسترد فعلًا.
- **طلب دُفع جزء منه من المحفظة** — عند استرداد جزء منه إلى "طريقة الدفع الأصلية" يعود بالطريقة نفسها التي دُفع بها: حصة المحفظة إلى المحفظة، والباقي إلى البطاقة. تعرض نافذة التأكيد المبلغين قبل إرسال أي شيء.
- **استرداد جزئي بدون إرجاع** (مثل استرداد أجريته من لوحة مزوّد الدفع، أو مبلغ جزئي من صفحة الطلب) — يُسجَّل كاسترداد من الإيرادات بالمبلغ نفسه تمامًا. لا يتحرك المخزون. ولا يُسجَّل الاسترداد نفسه مرتين مهما كرّر المزوّد الإبلاغ عنه.

---

## Where the buttons are (admin fix pass) — مكان الأزرار

- **Orders list:** one main button, **طلب تليفون جديد**. Export to Excel (owners only) is in the **...** menu next to it. There is no "back to store" button; use the Sales tab strip.
- **Order page:** reading order is the items and totals, then the customer and delivery, then payment, shipment, notes and documents. The bottom bar has the next step (for example **علّم الطلب مدفوع** or the next status). **Cancel the order**, the refund buttons, "refresh payment" and print live in the **...** menu, and cancelling asks you to confirm by naming the order.

- **قائمة الطلبات:** زرار رئيسي واحد **طلب تليفون جديد**. تنزيل Excel (للمالك بس) في قايمة **...** جنبه. مفيش زرار "رجوع للمتجر"، استخدم تبويبات المبيعات.
- **صفحة الطلب:** الترتيب: المنتجات والإجمالي، بعدين العميل والتوصيل، بعدين الدفع والشحن والملاحظات والمستندات. الشريط اللي تحت فيه الخطوة الجاية. **ألغي الطلب** وأزرار الاسترداد والطباعة جوه قايمة **...**، والإلغاء بيسألك وبيذكر اسم الطلب.
