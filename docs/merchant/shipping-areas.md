# Delivery Areas & Fees — مناطق التوصيل والرسوم

**Audience:** Store merchants | **التسمية:** تشغيلي — للتاجر

---

## What this feature does — ما الذي تفعله هذه الميزة

At checkout, customers pick their **Governorate** (محافظة) then their **Area** (منطقة) from a dependent dropdown. The platform shows only the areas that fall under the selected governorate. You set a delivery fee for each area you want to serve. Customers in areas with no fee set are hidden from selection — unless you have set **no** area rates at all, in which case all areas are visible and the platform falls back to your legacy shipping zones.

عند إتمام الطلب، يختار العميل المحافظة ثم المنطقة من قائمة منسدلة مرتبطة. تُعرض فقط المناطق التابعة للمحافظة التي اختارها. تُحدد أنت رسوم التوصيل لكل منطقة تريد خدمتها. المناطق التي لم تُسعَّر لا تظهر للعملاء — إلا إذا لم تُضف أي أسعار بعد، ففي هذه الحالة تظهر كل المناطق وتطبق مناطق الشحن القديمة كاحتياطي.

---

## How to set fees — كيفية ضبط الرسوم

1. Go to **Admin → Settings → Shipping → "Delivery areas & fees"**.
   انتقل إلى **لوحة التحكم → الإعدادات → الشحن → "مناطق التوصيل والرسوم"**.

2. Each governorate appears as a collapsible accordion section. Click a governorate to expand its areas.
   كل محافظة تظهر كقسم قابل للطي. اضغط على المحافظة لعرض مناطقها.

3. For each area, enter the delivery fee in **KWD** (e.g. `1.500` = 1,500 fils). Leave a field empty or zero to exclude that area.
   أدخل رسوم التوصيل بالدينار الكويتي لكل منطقة (مثال: `1.500` = 1500 فلس). اترك الحقل فارغًا أو صفرًا لاستثناء المنطقة.

4. Use **"Apply to all areas in this governorate"** (bulk-apply) to set the same fee for every area in a governorate at once. You can still adjust individual areas afterwards.
   استخدم زر **"تطبيق على جميع مناطق المحافظة"** لضبط نفس الرسوم على كل المناطق دفعة واحدة. يمكنك بعدها تعديل أي منطقة بشكل مستقل.

5. Click **Save** when done.
   اضغط **حفظ** عند الانتهاء.

---

## Bulk import & export — الاستيراد والتصدير بالجملة

If you serve many areas, you don't have to type every fee by hand. You can edit them all in a spreadsheet and upload the file.

إذا كنت تخدم مناطق كثيرة، لا داعي لإدخال كل رسم يدويًا. يمكنك تعديلها كلها في جدول بيانات ورفع الملف.

### Export — التصدير

1. In the **Delivery areas & fees** editor, click **Export**.
   في محرر **مناطق التوصيل والرسوم**، اضغط **تصدير**.

2. You receive an **Excel (.xlsx)** file. If you have already set fees, the file contains your current rates. If you haven't set any yet, the file is a **template** listing every Kuwait governorate and area with an empty fee column for you to fill in.
   تحصل على ملف **Excel (.xlsx)**. إذا كنت قد ضبطت رسومًا، يحتوي الملف على أسعارك الحالية. وإذا لم تضبط أيًا بعد، يكون الملف **قالبًا** يسرد كل محافظة ومنطقة في الكويت مع خانة رسوم فارغة لتعبئتها.

### Import — الاستيراد

1. Fill in the fee for each area you serve in the spreadsheet (you can use the exported Excel file, or a CSV with the same columns).
   عبّئ رسوم كل منطقة تخدمها في الجدول (يمكنك استخدام ملف Excel المُصدَّر، أو ملف CSV بنفس الأعمدة).

2. Back in the editor, click **Import** and choose your **.xlsx or .csv** file. Arabic and English column headers are both accepted.
   ارجع إلى المحرر، اضغط **استيراد** واختر ملف **.xlsx أو .csv**. تُقبل رؤوس الأعمدة بالعربية والإنجليزية.

3. The platform shows a **preview** of exactly which areas will be added or changed **before** anything is saved. Review it, then confirm to apply.
   تعرض المنصة **معاينة** للمناطق التي ستُضاف أو تتغيّر **قبل** الحفظ. راجعها ثم أكّد التطبيق.

> The preview is a dry run — nothing changes on your store until you confirm.
> المعاينة تجربة فقط — لا يتغيّر شيء في متجرك حتى تؤكّد.

---

## How "hide unpriced areas" works — كيف يعمل إخفاء المناطق غير المسعَّرة

| State                                   | Customer sees at checkout                            |
| --------------------------------------- | ---------------------------------------------------- |
| You have set **at least one** area rate | Only areas you priced (others hidden)                |
| You have **no** area rates at all       | All areas in all governorates (legacy zone fallback) |

| الحالة                                 | ما يراه العميل عند الدفع                           |
| -------------------------------------- | -------------------------------------------------- |
| أضفت **رسومًا لمنطقة واحدة على الأقل** | فقط المناطق التي حددت لها سعرًا                    |
| **لم تضف** أي رسوم بعد                 | كل المناطق في كل المحافظات (تطبيق المناطق القديمة) |

This means you can start small — price only the areas you deliver to today, and the rest are invisible to customers.

هذا يعني أنك تستطيع البدء بخطوات صغيرة — سعِّر المناطق التي توصل إليها الآن، والباقي لن يظهر للعملاء.

---

## Save-my-info — حفظ معلوماتي

When a customer completes checkout, the platform saves their selected governorate and area **on their device only** (browser local storage). On their next visit, the delivery address fields are pre-filled from that saved selection. No data is stored on our servers for this purpose. Customers can clear it by clearing their browser data.

عند إتمام العميل لطلبه، تحفظ المنصة المحافظة والمنطقة المختارة **على جهازه فقط** (التخزين المحلي للمتصفح). في الزيارة التالية، تُملأ حقول العنوان تلقائيًا من هذه البيانات المحفوظة. لا يتم تخزين أي بيانات على خوادمنا لهذا الغرض. يستطيع العميل مسحها بمسح بيانات المتصفح.

---

## Notes for merchants — ملاحظات للتجار

- Fees are per-delivery, not per-item. The displayed fee at checkout is the fee for the customer's selected area.
  الرسوم لكل طلب وليس لكل منتج. الرسوم المعروضة عند الدفع هي رسوم المنطقة التي اختارها العميل.

- You can activate or deactivate individual areas at any time without deleting the saved fee.
  يمكنك تفعيل أو تعطيل أي منطقة في أي وقت دون حذف الرسوم المحفوظة.

- Changes take effect immediately for new orders. Existing orders are not affected.
  التغييرات تسري فورًا على الطلبات الجديدة. الطلبات الموجودة لا تتأثر.
