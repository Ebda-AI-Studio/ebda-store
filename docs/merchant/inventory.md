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

> **Plan note:** barcode scanning is an **Enterprise** feature. If your plan doesn't include it, the Scan page shows an upgrade prompt — talk to your Force AI account manager.

صفحة **المخزون → المسح** تتيح العمل بالباركود من هاتفك في ثلاثة أوضاع:

- **استلام** — مسح العناصر عند وصولها لإضافتها للمخزون.
- **تجهيز** — مسح العناصر أثناء تنفيذ الطلب للتأكد من تجهيز المنتجات الصحيحة.
- **جرد** — تنفيذ جرد دوري بمسح الرفوف ومطابقة النتيجة مع المخزون المسجّل.

يستخدم ماسح الباركود المدمج في هاتفك حين يتوفر، ويتيح إدخال الرمز يدويًا كبديل.

> **ملاحظة الباقة:** مسح الباركود ميزة **مؤسسية (Enterprise)**. إذا كانت باقتك لا تتضمنها، تعرض صفحة المسح رسالة ترقية — تواصل مع مدير حسابك في Force AI.

---

## Bulk stock import — استيراد المخزون بالجملة

For large reconciliations, Enterprise stores can upload a CSV with SKU or Barcode plus a new quantity (absolute) or a delta (signed +/−) to adjust hundreds of products at once, with a preview before applying. (Stock → Bulk adjustments.)

للمطابقات الكبيرة، تستطيع المتاجر المؤسسية رفع ملف CSV يحتوي على رمز المنتج أو الباركود مع كمية جديدة (مطلقة) أو تغيير (موجب/سالب) لتعديل مئات المنتجات دفعةً واحدة، مع معاينة قبل التطبيق. (المخزون → التعديلات المجمّعة.)

---

## Dead stock & reorder suggestions — البضاعة الراكدة واقتراحات إعادة الطلب

**Dead stock** (Stock → Dead Stock) is refreshed weekly. A product is flagged when it is in stock, has not sold for 90 days or more, and its stock is worth at least KWD 50 at cost. A product with **no cost price** is still flagged — its value shows as **Unknown (no cost price)**, and a note at the top counts how many flagged products need a cost price. Add cost prices on the product page so the scan can value them. A product that has never sold shows **Never sold**.

**Reorder suggestions** (Stock → Reorder Suggestions) are refreshed daily. Each product has **one** open suggestion (or one open dead-stock card) at a time: each scan updates it with the latest numbers instead of adding another. Dismissing it closes it; if the product still qualifies, the next scan opens a new one.

**البضاعة الراكدة** (المخزون ← البضاعة الراكدة) تُحدَّث أسبوعياً. يُحدَّد المنتج عندما يكون متوفراً في المخزون ولم يُبَع منذ 90 يوماً أو أكثر وتبلغ قيمة مخزونه بسعر التكلفة 50 د.ك على الأقل. المنتج **الذي ليس له سعر تكلفة** يُحدَّد أيضاً — تظهر قيمته **غير معروفة (لا يوجد سعر تكلفة)**، ويعرض تنبيه في أعلى الصفحة عدد المنتجات المحدَّدة التي تحتاج إلى سعر تكلفة. أضف أسعار التكلفة من صفحة المنتج ليتمكن الفحص من تقييمها. المنتج الذي لم يُبَع أبداً يظهر **لم يُبَع أبداً**.

**اقتراحات إعادة الطلب** (المخزون ← اقتراحات إعادة الطلب) تُحدَّث يومياً. لكل منتج اقتراح مفتوح **واحد** (أو بطاقة بضاعة راكدة مفتوحة واحدة) في كل مرة: كل فحص يحدّثه بأحدث الأرقام بدلاً من إضافة اقتراح جديد. تجاهله يغلقه؛ وإذا ظل المنتج مستوفياً للشروط، يفتح الفحص التالي اقتراحاً جديداً.
