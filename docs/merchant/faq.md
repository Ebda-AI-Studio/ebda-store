# FAQ — الأسئلة الشائعة

The most common merchant questions, with concrete answers. أكثر الأسئلة شيوعًا بإجابات واضحة.

## General

### How much does Force AI Store cost? — كم تكلفة Force AI Store؟

Pricing is set per merchant by Force Media. Contact your account manager. There's no per-transaction commission collected by Force AI Store itself — your payment provider's fees are separate (2.5–2.85% typically).

السعر يُحدّد لكل تاجر على حدة من Force Media. لا توجد عمولة على المعاملات من Force AI Store؛ رسوم بوابة الدفع منفصلة (2.5%–2.85% تقريبًا).

### What's the difference between Force AI Store and Shopify / Salla? — الفرق بين Force AI Store وShopify أو سلّة؟

- **Built for Kuwait first**: KNET, all 4 Kuwait payment providers (Tap/MyFatoorah/Hesabe/UPayments) ship out of the box. Arabic + English are first-class, not afterthoughts.
- **All AI features free**: translation, SEO meta tags, category suggestions, FAQ generation — built-in via Gemini, no AppStore add-ons.
- **No commission on sales**: only the flat platform fee. Shopify Plus + a payment app would total 4–6% per sale.
- **Operated by Force Media**: direct WhatsApp support, not a Western support ticket queue.

مخصّصة للسوق الكويتي، كل خصائص AI مجانية، لا عمولة على المبيعات، دعم مباشر بالعربي من Force Media.

### Can I export my data if I leave? — أقدر أنقل بياناتي لو غادرت؟

Yes. **Admin → Settings → Data Export** generates a JSON bundle of your products, categories, orders, customers (GDPR Art. 20 portability). Your customer data is yours.

نعم. تستطيع تصدير منتجاتك، فئاتك، طلباتك، عملاءك كملف JSON كامل من إعدادات الحساب.

### How will I know if the terms or policies change? — هعرف إزاي لو الشروط أو السياسات اتغيرت؟

Every policy page on ebda.app shows its version and the date it was last updated. When we make a material change (for example to fees), we email the store owner and show a notice in your dashboard with a summary, the date it takes effect and a link; press "Got it" to dismiss it. Fee changes always come with at least 30 days' notice, counted from the day we send you that notice. You can see which policy versions you accepted, and when, under Account → Security → **Policies you accepted**.

كل صفحة سياسة على ebda.app بتوضح رقم الإصدار وتاريخ آخر تحديث. لما نعمل تغيير جوهري (زي الرسوم) بنبعت إيميل لصاحب المتجر وبيظهر لك إشعار في لوحة التحكم فيه ملخص التغيير وتاريخ سريانه ورابط للسياسة؛ دوس «تمام، فهمت» علشان يختفي. أي تغيير في الرسوم بيكون بإشعار 30 يوم على الأقل.

---

## Products

### How many products can I add? — كم منتج أقدر أضيف؟

No hard limit at the platform level. We've tested with 10,000+ products per store. Stores with > 5,000 products may want to enable cursor-based pagination for catalog browse — contact support if you're growing past that.

لا حدّ تقني عند المنصة. اختبرنا متاجر فيها أكثر من 10,000 منتج. لو تجاوزت 5,000، تواصل معنا لتفعيل تنقّل أسرع.

### Can I bulk-import products from a spreadsheet? — أقدر أرفع منتجات من Excel؟

Yes. **Admin → Products → Import**:

- Download the CSV template
- Fill it in (one row per product) — required columns: name, name_ar, price, category_slug, image_url
- Upload — Force AI Store validates, then queues the import as a background job. Status visible in **Admin → Jobs**
- Smart-skip: existing products (matched by SKU) are updated, new ones created. No duplicates.

نعم — حمّل قالب CSV، عبّيه، ارفعه. الخلفية تعالج الاستيراد وتحدّث الموجود وتنشئ الجديد. مافي تكرار.

### Why does my Arabic product name look wrong on the storefront? — لماذا اسم المنتج بالعربي يبان غريب؟

Common causes:

1. RTL (right-to-left) marks copied from a Word document — these invisible characters break alignment. Fix: re-type the name directly in the admin form.
2. Mixed digits — Latin digits inside Arabic text look misaligned. Decision is yours: Force AI Store doesn't auto-convert. Stick to one digit system within a single field.
3. Browser language vs. storefront language — the storefront toggle is independent of your browser. Hit the AR/EN toggle to confirm what your customer sees.

الأسباب الشائعة: علامات RTL مخفية منسوخة من Word (أعد كتابة الاسم مباشرة)، أرقام لاتينية داخل نص عربي (اختر نظام واحد)، اختلاف لغة المتصفّح عن لغة المتجر (افحص بالتبديل من واجهة المتجر).

---

## Wholesale — الجملة

### How do I set quantity prices for a product? — إزاي أحط أسعار بالكمية لمنتج؟

Open the product, find **Wholesale pricing**, add a price break (from quantity, unit price). Leave **Who gets it** on *Everyone* for a public break, or pick a customer group for wholesale-only prices. The price must be lower than the current price, and a bigger quantity must be cheaper than a smaller one. The card shows your margin against the cost price and warns (without blocking) when a price is below cost. Wholesale pricing is part of the Business plan.

افتح المنتج، وهتلاقي **أسعار الجملة**: أضف شريحة (من كمية، وسعر الوحدة). سيب **مين بياخدها** على "الكل" لشريحة عامة، أو اختار مجموعة عملاء لأسعار الجملة بس. السعر لازم يبقى أقل من السعر الحالي، والكمية الأكبر أرخص من الأصغر. الكارت بيوريك هامشك على التكلفة وبيحذّرك لو السعر أقل منها. أسعار الجملة جزء من باقة Business.

### How do I approve a wholesale buyer? — إزاي أوافق على تاجر جملة؟

Create a customer group, tick **Wholesale group**, and (optionally) set a percent discount. Buyers apply from their account page; you get a notification, a badge on the **Wholesale applications** tab and an email. Open the application, pick the group and approve. The buyer sees wholesale prices from their next page load, but only when signed in: a phone number or email typed at checkout never unlocks them. Rejecting sends them your note, so do not write internal remarks there. If nobody answers for 48 hours you get a reminder.

اعمل مجموعة عملاء، وعلّم **مجموعة جملة**، وحط نسبة خصم لو عايز. التجار بيقدّموا من صفحة حسابهم، وبيوصلك إشعار وعلامة على تبويب **طلبات الجملة** وإيميل. افتح الطلب، واختار المجموعة ووافق. التاجر بيشوف أسعار الجملة من أول تحميل للصفحة، بس وهو مسجّل دخول: رقم تليفون أو إيميل مكتوب في الدفع عمره ما بيفتحها. لو رفضت، التاجر بيشوف ملاحظتك، فمتكتبش فيها ملاحظات داخلية. لو محدش رد 48 ساعة بيوصلك تذكير.

### Why does a coupon not apply to a wholesale line? — ليه الكوبون مش بيشتغل على صنف جملة؟

Lines sold at a quantity price or a wholesale group price are excluded from coupons, promotions and loyalty redemption, because wholesale margins are thin and stacking can take the price below cost. Free-shipping coupons still work. The rest of the cart (retail lines) keeps its coupon.

الأصناف اللي اتباعت بسعر كمية أو سعر مجموعة جملة مش داخلة في الكوبونات والعروض واستبدال نقاط الولاء، لأن هامش الجملة صغير والتجميع ممكن ينزل بالسعر تحت التكلفة. كوبون الشحن المجاني شغال. باقي السلة (الأصناف العادية) بيفضل عليها الكوبون.

### What happens when a wholesale buyer returns part of an order? — إيه اللي بيحصل لو تاجر جملة رجّع جزء من الطلب؟

If the units the buyer keeps of a product (all its sizes and lines counted together, the same way the price break was given) no longer reach the quantity they were sold at, the kept units are repriced at the best price the buyer still had for that quantity (a price break they still reach, or their wholesale group's discount, otherwise the retail price) and the refund is reduced by the difference. The return screen shows the standard refund, the adjustment with the reason, and the adjusted refund before you confirm. You can override the amount per item (a reason is required and the change is recorded with your name). The refund is never below zero, and a later return that brings the buyer back over the threshold releases what was held back.

لو الوحدات اللي التاجر محتفظ بيها من المنتج (كل المقاسات والسطور بتتحسب مع بعض، زي ما الشريحة اتحسبت) مبقتش توصل للكمية اللي اتباعت بيها، بتتسعّر بأحسن سعر لسه من حقه للكمية دي (شريحة لسه واصلها، أو خصم مجموعة الجملة بتاعته، وإلا سعر القطاعي) والمرتجع بيقل بالفرق. شاشة المرتجع بتوريك المرتجع العادي والتعديل بسببه والمرتجع بعد التعديل قبل ما تأكد. تقدر تعدّل المبلغ لكل صنف (السبب مطلوب والتغيير بيتسجّل باسمك). المرتجع عمره ما بينزل تحت صفر، ولو مرتجع بعده رجّع التاجر فوق الحد، اللي اتحجز بيتفك.

## Orders

### Where do new orders appear? — وين الطلبات الجديدة؟

**Admin → Orders** — sorted by newest first.

Real-time push notification fires to your phone if you've installed Force AI Store as a PWA (Progressive Web App) and granted push permission. Setup: open the admin in Chrome/Safari, tap Share → Add to Home Screen, accept the notification prompt.

تظهر في «الطلبات». لو ثبّت لوحة الإدارة كتطبيق على جوالك (PWA)، تصلك تنبيهات فورية لكل طلب جديد.

### How do I refund an order? — كيف أعمل استرجاع؟

**Admin → Orders → [order] → Refund**.

- Select full or partial refund
- Choose reason (optional)
- Click Refund — Force AI Store calls the payment provider's refund API automatically

Refunds appear in your customer's account within 5–7 business days depending on their bank. The Force AI Store order status updates to `refunded`.

من صفحة الطلب اضغط «استرجاع». يحدث الاسترجاع تلقائيًا عند مزوّد الدفع. يظهر في حساب العميل خلال 5–7 أيام عمل.

### Can I edit an order after it's been placed? — أقدر أعدّل طلب بعد ما يُسجَّل؟

Limited editing only:

- ✅ Update shipping address (before shipment)
- ✅ Add tracking number
- ✅ Update order status (processing → shipped → delivered)
- ✅ Add internal notes (only you see them)
- ❌ Change product quantities or prices — would require canceling + re-creating the order (and likely refunding)

Force AI Store deliberately blocks price/quantity edits to maintain a clean audit trail. If a customer wants to change items, ask them to cancel and re-order.

التعديل محدود: تقدر تغيّر عنوان الشحن، رقم التتبّع، الحالة. لا تقدر تعدّل الأسعار أو الكميات (للحفاظ على السجل). للتغييرات الكبيرة، الإلغاء وإعادة الطلب.

---

## Payments

### A customer says they paid but I see status=pending. What now? — العميل دفع لكن الحالة pending؟

This happens when the payment provider's webhook hasn't reached us yet (~1–60 min delay, very rare).

1. Wait 5 min and refresh the order page
2. If still pending: check the payment provider's dashboard — search by the customer's email or the order ID
3. If the provider shows the payment as completed: contact Force Media support with the order ID + transaction ID; we can manually reconcile after verifying

يحدث نادرًا لو تأخّر webhook المزوّد. انتظر 5 دقائق ثم افحص في لوحة بوابة الدفع. لو الدفع تمّ هناك لكن لم يصل لنا، تواصل مع الدعم بمعرف الطلب + معرف العملية.

### My payment provider keeps failing. How do I diagnose? — مزوّد الدفع يرفض كل المحاولات؟

Check in order:

1. **Test mode**: is the toggle set correctly? Test mode rejects real cards; live mode rejects test cards.
2. **Webhook secret**: was it copied correctly? A single character off and Force AI Store treats every webhook as forged.
3. **API key permissions**: did the provider give you a "Public" key by mistake? Force AI Store needs the Secret/Live key.
4. **Provider account status**: is your account in good standing? Tap, MyFatoorah etc. occasionally pause accounts pending compliance review.

تحقّق بهذا الترتيب: وضع الاختبار/المباشر، صحة سر webhook، مفتاح API (سرّي وليس عام)، حالة حسابك عند المزوّد.

---

## Storefront

### How do I change the storefront colors? — كيف أغيّر ألوان المتجر؟

**Admin → Branding → Theme**

Pick your theme (Modern / Classic / Minimal / Bold / Elegant), then set your primary and accent brand colors. Force AI Store auto-generates the full palette (hover states, disabled states, etc.) from those two. Preview live on the right pane.

من «Branding → Theme»: اختر القالب ثم اللون الرئيسي + اللون الثانوي. باقي درجات الألوان تُولَّد تلقائيًا. معاينة مباشرة بجانب الاختيار.

### Can I rearrange the home page sections? — أقدر أرتّب أقسام الصفحة الرئيسية؟

Yes. **Admin → Page Builder**:

- Drag-and-drop the sections to reorder
- Toggle visibility per section
- Configure each section's content (featured categories: pick which; testimonials: pick which to show; etc.)
- The Page Builder also manages Storefront Navigation links, Footer links, and Category page config — all in one place

نعم — من «Page Builder»: اسحب وأفلت لإعادة الترتيب، فعّل أو أوقف أي قسم، اختر محتوى كل قسم. Page Builder يضم أيضًا إعدادات التنقل والفوتر وصفحات الفئات.

### Can I add a blog? — أقدر أضيف مدوّنة؟

Yes — Force AI Store has a full built-in blog:

- **Admin → Blog** — create, edit, and publish blog posts in Arabic and English
- Blog posts appear in a carousel on your storefront homepage when the blog is enabled
- Each post has bilingual rich-text editing, a cover image, and SEO meta fields (bilingual)

Static pages (About Us, Shipping Policy, Return Policy, Privacy Policy, custom pages) are managed separately under **Admin → Pages**.

نعم — Force AI Store تدعم المدوّنة الكاملة: أنشئ مقالات من «Admin → Blog»، تظهر في كاروسيل على الصفحة الرئيسية. الصفحات الثابتة (من نحن، الشحن، الإرجاع، إلخ) من «Admin → Pages».

---

## Customers

### Are customer accounts required to checkout? — هل التسجيل إجباري للشراء؟

No. Guest checkout is enabled by default — customers can complete an order with just an email + phone + delivery address. Optionally they can register an account on the confirmation page (Force AI Store offers one-tap registration to save the order to a new account).

لا. الدفع كزائر متاح افتراضيًا — يكفي إيميل ورقم وعنوان. اختياريًا يقدر العميل يسجّل في صفحة التأكيد.

### Can I see what my customers searched for? — أقدر أعرف وش بحثوا عنه عملائي؟

**Admin → Analytics → Search Terms** — shows top search queries from your storefront over the last 30 days. Use this to identify products you don't yet stock that customers are looking for.

من «التحليلات → كلمات البحث». تشوف أكثر العبارات اللي بحث عنها العملاء في آخر 30 يوم — مفيد لاكتشاف منتجات تحتاجها ما هي موجودة.

### Why do abandoned carts or "checkouts started" say "Not tracked for guest checkout"? — لماذا تظهر «غير متتبَّع للدفع كضيف»؟

Abandoned-cart recovery needs a way to reach the shopper, so a cart is only recorded when it belongs to a signed-in customer with an email or phone. Guest checkout does not capture a contact before the order is placed, so guest carts are never recorded. On a store that takes guest orders, Abandoned Carts and the funnel's **Checkouts Started** / **Abandoned** show **Not tracked for guest checkout** instead of a misleading 0. Where some carts do belong to signed-in customers, the numbers are shown and labelled **Registered customers only**.

استرجاع السلات المتروكة يحتاج وسيلة للتواصل مع العميل، لذلك تُسجَّل السلة فقط إذا كانت لعميل مسجَّل الدخول لديه بريد أو رقم هاتف. الدفع كضيف لا يحفظ وسيلة تواصل قبل إتمام الطلب، فلا تُسجَّل سلات الضيوف. في المتجر الذي يستقبل طلبات ضيوف، تعرض صفحة السلات المتروكة وخانتا **عمليات دفع بدأت** و**مهجورة** في القمع عبارة **غير متتبَّع للدفع كضيف** بدلاً من 0 مضلِّل. وإذا كانت بعض السلات لعملاء مسجَّلين، تظهر الأرقام مع عبارة **العملاء المسجَّلون فقط**.

### Why do Insights and Analytics show different conversion numbers? — لماذا تختلف أرقام التحويل بين «الرؤى» و«التحليلات»؟

They measure different steps. **Analytics → Conversion rate** is orders per product view. **Insights → Yesterday's funnel → Cart → order** is orders per cart created. A shopper who views, adds to cart and buys counts in both, but the denominators differ, so the numbers are not expected to match.

يقيسان خطوتين مختلفتين. **التحليلات ← معدل التحويل** هو عدد الطلبات لكل مشاهدة منتج. أما **الرؤى ← مسار الشراء أمس ← من السلة إلى الطلب** فهو عدد الطلبات لكل سلة أُنشئت. المقام مختلف، لذلك لا يُتوقَّع أن يتطابق الرقمان.

### Why does Gross profit (GL) say "Unknown"? — لماذا يظهر إجمالي الربح (دفتر الأستاذ) «غير معروف»؟

Gross profit is revenue minus the cost of the goods sold. When no cost was booked for the period — the products sold had no cost price — the figure would just repeat revenue, so it shows **Unknown** instead. Add cost prices to your products (and variants); orders placed after that book their cost automatically.

إجمالي الربح هو الإيرادات ناقص تكلفة البضاعة المباعة. إذا لم تُسجَّل أي تكلفة للفترة — لأن المنتجات المباعة بلا سعر تكلفة — فسيكرر الرقم الإيرادات فقط، لذلك يظهر **غير معروف**. أضف أسعار التكلفة لمنتجاتك (وخياراتها)؛ الطلبات التي تأتي بعد ذلك تُسجِّل تكلفتها تلقائياً.

---

## Technical

### Why does my storefront load slowly the first time? — لماذا المتجر بطيء أوّل مرة؟

The first visitor every ~5 minutes "warms up" Force AI Store's edge cache. Subsequent visitors are served from cache (~50ms). If first-load is consistently >3 seconds, contact support — that's not normal.

أول زائر كل 5 دقائق «يدفّي» الكاش. الزوار اللاحقون يحصلون على ردّ سريع (50 مللي ثانية). لو الأول-تحميل بطيء باستمرار (أكثر من 3 ثوان)، تواصل معنا.

### Is my data backed up? — هل بياناتي محفوظة احتياطيًا؟

Yes — at multiple layers:

1. Every push to production triggers a Neon database branch snapshot (per-commit point-in-time)
2. Daily database dumps are stored encrypted-at-rest
3. The platform maintains 30-day log retention for incident investigation

If you ever lose data (accidentally deleted a category, etc.), contact us within 7 days for restoration.

نعم — نسخ احتياطية على عدّة طبقات: لقطة قاعدة بيانات مع كل نشر، نسخ يومية مشفّرة، احتفاظ بسجلات 30 يوم. لو حذفت شيء بالغلط، تواصل معنا خلال 7 أيام.

### What happens if Force AI Store goes down? — وش يصير لو Force AI Store تعطّلت؟

Status page: <https://stats.uptimerobot.com/23nuarbz3h> — check there first.

If the platform is down:

1. Storefront shows a friendly "we're back soon" message instead of an error
2. Pending orders are queued and processed when service restores
3. Email notifications continue (they're handled out-of-band by a queue)

Recent uptime: > 99.9% (single-region, single-replica architecture — see [troubleshooting.md](./troubleshooting.md) for incident handling).

في حالة عطل: المتجر يعرض رسالة «نعود قريبًا» بدلًا من خطأ، الطلبات المعلّقة تُعالج فور عودة الخدمة، الإيميلات تستمر. وقت التشغيل الفعلي > 99.9%.

---

## Still have a question? — لا زال عندك سؤال؟

- WhatsApp: contact your Force Media account manager
- Email: contact@forcemediakw.com
- Check [troubleshooting.md](./troubleshooting.md) for specific error scenarios
