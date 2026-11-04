# Inventory: variant stock, adjustments & scanning — المخزون: مخزون التنويعات والتعديلات والمسح

**Audience:** Store merchants & staff | **التسمية:** تشغيلي — للتاجر والموظفين

---

## Stock at a glance — المخزون بنظرة

Open **Admin → Stock → Inventory** to see current stock across your catalog.

- For a product that has **variants** (sizes, colors, flavors), the list shows a **variant stock total** — the sum of every variant's stock — so one number reflects the whole product.
- The inventory page **paginates** through your entire catalog. There is no product-count limit; large catalogs page through normally instead of being cut off.

افتح **لوحة التحكم → المخزون → المخزون** لرؤية الكميات الحالية عبر كتالوجك.

- المنتج الذي له **تنويعات** (مقاسات، ألوان، نكهات) يعرض **إجمالي مخزون التنويعات** — مجموع مخزون كل تنويعة — ليعكس رقمٌ واحد المنتج كاملًا.
- تعرض صفحة المخزون كتالوجك كاملًا عبر **صفحات متعددة**. لا يوجد حد لعدد المنتجات؛ الكتالوجات الكبيرة تُقسَّم لصفحات بدلًا من اقتطاعها.

---

## Stock adjustments — تعديلات المخزون

Log any stock movement from **Stock → Adjustments**: received goods, damaged items, corrections, and so on. Each adjustment **type** carries a short plain-language explanation, so you (or your staff) pick the right one without guessing.

سجّل أي حركة مخزون من **المخزون → التعديلات**: بضاعة مستلمة، تالفة، تصحيحات، وغيرها. كل **نوع** تعديل يحمل شرحًا مبسطًا، لتختار (أنت أو موظفوك) النوع الصحيح دون تخمين.

---

## Scanning: Receive / Pick / Count — المسح: استلام / تجهيز / جرد

The **Stock → Scan** page lets you work with barcodes from your phone in three modes:

- **Receive** — scan items as they arrive to add them to stock.
- **Pick** — scan items while fulfilling an order to confirm you're picking the right products.
- **Count** — run a cycle count by scanning shelves and reconciling the result against recorded stock.

It uses your phone's built-in barcode scanning where available, and falls back to typing the code by hand otherwise.

> **Plan note:** barcode scanning is an **Enterprise** feature. If your plan doesn't include it, the Scan page shows an upgrade prompt — talk to your Ebda AI Studio account manager.

صفحة **المخزون → المسح** تتيح العمل بالباركود من هاتفك في ثلاثة أوضاع:

- **استلام** — مسح العناصر عند وصولها لإضافتها للمخزون.
- **تجهيز** — مسح العناصر أثناء تنفيذ الطلب للتأكد من تجهيز المنتجات الصحيحة.
- **جرد** — تنفيذ جرد دوري بمسح الرفوف ومطابقة النتيجة مع المخزون المسجّل.

يستخدم ماسح الباركود المدمج في هاتفك حين يتوفر، ويتيح إدخال الرمز يدويًا كبديل.

> **ملاحظة الباقة:** مسح الباركود ميزة **مؤسسية (Enterprise)**. إذا كانت باقتك لا تتضمنها، تعرض صفحة المسح رسالة ترقية — تواصل مع مدير حسابك في Ebda AI Studio.

---

## Bulk stock import — استيراد المخزون بالجملة

For large reconciliations, Enterprise stores can upload a CSV with SKU or Barcode plus a new quantity (absolute) or a delta (signed +/−) to adjust hundreds of products at once, with a preview before applying. (Stock → Bulk adjustments.)

للمطابقات الكبيرة، تستطيع المتاجر المؤسسية رفع ملف CSV يحتوي على رمز المنتج أو الباركود مع كمية جديدة (مطلقة) أو تغيير (موجب/سالب) لتعديل مئات المنتجات دفعةً واحدة، مع معاينة قبل التطبيق. (المخزون → التعديلات المجمّعة.)

---

## Dead stock & reorder suggestions — البضاعة الراكدة واقتراحات إعادة الطلب

**Dead stock** (Stock → Dead Stock) is refreshed weekly. A product is flagged when it is in stock, has not sold for 90 days or more, and its stock is worth at least EGP 50 at cost. A product with **no cost price** is still flagged — its value shows as **Unknown (no cost price)**, and a note at the top counts how many flagged products need a cost price. Add cost prices on the product page so the scan can value them. A product that has never sold is counted from the day it was added, so a new product is not flagged in its first 90 days; once flagged it shows **Never sold**.

**Reorder suggestions** (Stock → Reorder Suggestions) are refreshed daily. A product **with variants** gets one suggestion per active variant — each card names the variant (e.g. "Variant: Large"), uses that variant's own stock and sales, and **Draft PO** orders that variant at its own cost. A disabled variant never gets one. A product without variants gets one suggestion for the product. Each has **one** open suggestion (or one open dead-stock card) at a time: each scan updates it with the latest numbers instead of adding another. Dismissing it closes it; if it still qualifies, the next scan opens a new one. Suggestions made before per-variant reordering (one per product) close themselves on the next scan. When you create a purchase order by hand, a product with variants needs a variant chosen on every line.

**البضاعة الراكدة** (المخزون ← البضاعة الراكدة) تُحدَّث أسبوعياً. يُحدَّد المنتج عندما يكون متوفراً في المخزون ولم يُبَع منذ 90 يوماً أو أكثر وتبلغ قيمة مخزونه بسعر التكلفة 50 د.ك على الأقل. المنتج **الذي ليس له سعر تكلفة** يُحدَّد أيضاً — تظهر قيمته **غير معروفة (لا يوجد سعر تكلفة)**، ويعرض تنبيه في أعلى الصفحة عدد المنتجات المحدَّدة التي تحتاج إلى سعر تكلفة. أضف أسعار التكلفة من صفحة المنتج ليتمكن الفحص من تقييمها. المنتج الذي لم يُبَع أبداً يُحتسب من يوم إضافته، فلا يُحدَّد المنتج الجديد خلال أول 90 يوماً؛ وعند تحديده يظهر **لم يُبَع أبداً**.

**اقتراحات إعادة الطلب** (المخزون ← اقتراحات إعادة الطلب) تُحدَّث يومياً. المنتج **الذي له متغيرات** يحصل على اقتراح لكل متغير مفعّل — كل بطاقة تذكر المتغير (مثلاً «المتغير: كبير») وتستخدم مخزونه ومبيعاته، و**إنشاء أمر شراء** يطلب ذلك المتغير بتكلفته. المتغير المعطّل لا يحصل على اقتراح. المنتج بدون متغيرات يحصل على اقتراح واحد للمنتج. لكلٍّ اقتراح مفتوح **واحد** (أو بطاقة بضاعة راكدة مفتوحة واحدة) في كل مرة: كل فحص يحدّثه بأحدث الأرقام بدلاً من إضافة اقتراح جديد. تجاهله يغلقه؛ وإذا ظل مستوفياً للشروط، يفتح الفحص التالي اقتراحاً جديداً. الاقتراحات القديمة (واحد لكل منتج) تُغلق تلقائياً في الفحص التالي. عند إنشاء أمر شراء يدوياً، يجب اختيار المتغير في كل سطر لمنتج له متغيرات.

---

## Disabled variants and stock value — التنويعات المعطّلة وقيمة المخزون

A variant you **disable** is no longer stock anywhere — not on the storefront, not in the inventory counts, and **not in your stock value**, even if it still holds units. The finance dashboard, the analytics inventory card, the inventory page and the dead-stock list all leave it out. Disabling a variant does **not** write anything to your accounts, so the stock value on the finance dashboard can be lower than the Inventory line of your balance sheet by the cost of those units. Enable the variant again and its units count again.

التنويعة التي **تعطّلها** لا تُحسب مخزونًا في أي مكان — لا في المتجر، ولا في أعداد المخزون، **ولا في قيمة المخزون**، حتى لو كانت ما زالت تحمل وحدات. لوحة المالية وبطاقة المخزون في التحليلات وصفحة المخزون وقائمة المخزون الراكد كلها تستبعدها. تعطيل التنويعة **لا** يسجّل أي قيد في حساباتك، لذلك قد تكون قيمة المخزون في لوحة المالية أقل من بند المخزون في الميزانية بمقدار تكلفة تلك الوحدات. أعد تفعيل التنويعة لتُحتسب وحداتها من جديد.

---

## Stock adjustments and counts — تعديلات المخزون والجرد (2026-11-04)

**Stock adjustments** (Stock → Stock adjustments, formerly "Adjustments / تسويات"). The page has one main button, **New stock adjustment**, in the header. On the new-adjustment page the manual form is the default tab (CSV import is the second tab). **Save as draft** keeps it for review; **Approve adjustment** changes your stock and posts the matching entry to your accounts, and cannot be undone, so a confirmation names how many products it touches first.

**Stock counts** (Stock → Scan → Count). **Close the count** asks first and says how many items were counted. **Approve differences** asks first and says how many items differ and the net units; it then adjusts stock for every item that differs and posts it to your accounts, and cannot be undone.

**Warehouses, suppliers and purchase orders.** Row actions are an "…" menu with _Deactivate_ / _Cancel_ last and in red. A failed save or deactivate now shows an error instead of a success message. The purchase order page has **Receive goods** in the header and **Cancel purchase order** in the "…" menu.

**Backorder for all products** moved from a header button to the "…" menu on the Inventory page and asks first.

**تعديلات المخزون** (المخزون ← تعديلات المخزون): الصفحة فيها زرار رئيسي واحد في الأعلى «تعديل مخزون جديد». في صفحة التعديل الجديد النموذج اليدوي هو الأول، واستيراد CSV تبويب تاني. **احفظ كمسودة** بيخلّيه للمراجعة، و**اعتمد التعديل** بيغيّر المخزون فعلاً وبيتسجّل في حساباتك ومش بيترجع، فبنسألك الأول وبنقولك عدد المنتجات. **الجرد**: «اقفل الجرد» و«اعتمد الفروقات» بيسألوك الأول، والتاني بيقولك كام صنف فيه فرق وصافي الوحدات.
