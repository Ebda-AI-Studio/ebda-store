# Quickstart — البدء السريع

Get your store live in under an hour. متجرك جاهز خلال ساعة.

## 1. Sign in to the admin

URL: <https://app.forcemediakw.com>

Your Force Media contact will create your account and email you the temporary password. On first login, you'll be asked to change it.

سيتم إنشاء حسابك من قِبل فريق Force Media وستصلك كلمة مرور مؤقتة بالإيميل. غيّرها عند أول دخول.

## 2. Set your store identity

**Admin → Settings → Store Profile**

Fill in:

- Store name (English) + Store name (Arabic) — both shown on the storefront
- Store description (EN + AR) — appears in search results + on the home page
- Logo upload — square PNG ≥ 400×400 recommended
- Brand colors — primary + accent (will theme the storefront automatically)
- Default currency — KWD for Kuwait
- WhatsApp contact number — appears as the floating contact button

أدخل اسم متجرك ووصفه بالإنجليزية والعربية، ارفع شعار المتجر (PNG مربّع 400×400 على الأقل)، اختر الألوان الأساسية، ضع رقم الواتساب للتواصل.

## 3. Add categories

**Admin → Categories**

Categories organize your products into navigable groups. Each category has:

- Name (EN + AR)
- Slug (auto-generated from English name; e.g. `coffee-beans`)
- Image (optional — appears as the category tile on the home page)
- Display order — lower numbers appear first

You can drag-and-drop to reorder. Empty categories are hidden from the storefront automatically.

أضف فئات تنظّم منتجاتك. كل فئة لها اسم بالعربية + الإنجليزية، صورة (اختيارية)، ترتيب عرض. السحب-والإفلات يعيد ترتيبها. الفئات الفارغة لا تظهر للزائر.

## 4. Add your first products

**Admin → Products → + Add Product**

Required fields:

- Name (EN + AR)
- Price in KWD (Kuwaiti Dinar)
- At least 1 image (drag-and-drop upload)
- Stock quantity (or mark "always in stock" for digital products)
- Category — assign to at least one

Optional but recommended:

- **Discount** — choose None, Percentage (%), or Fixed KWD from the dropdown. The discounted price previews live as you type and shows as a "Was / Now" strikethrough on the storefront automatically. (No need to manually fill "compare-at-price" — it is derived from your discount setting.)
- SKU — your internal product code
- Weight in grams — needed for shipping calculations
- Description (EN + AR) — formatted text with images

**AI assist**: every text field has a sparkle ✨ button that auto-generates the Arabic translation, SEO meta tags, or category suggestions using Gemini AI. Free, no API key needed.

كل حقل نصي فيه زر ✨ يولّد الترجمة العربية، أوصاف SEO، أو اقتراحات التصنيف تلقائيًا (مجانًا، بدون مفاتيح إضافية).

## 5. Configure payment

**Admin → Settings → Payment Settings**

Force Store supports 4 Kuwait-based payment providers:

- Tap Payments
- MyFatoorah
- Hesabe
- UPayments

Plus Cash on Delivery (COD) which needs no provider account.

You need merchant accounts with at least one payment provider. See [payment-providers.md](./payment-providers.md) for the per-provider account opening + credential walkthrough.

Cash on Delivery works out of the box — just enable the toggle. You can add a fixed COD fee (e.g. 1 KWD) which is added to the order total.

تحتاج حسابًا مع مزوّد دفع واحد على الأقل. الدفع عند الاستلام يعمل مباشرة من غير حساب — فعّله من الإعدادات وضع رسوم ثابتة (مثلًا 1 د.ك) إذا أردت.

## 6. Configure shipping

**Admin → Settings → Shipping**

Set up shipping zones:

- Within Kuwait — usually one zone with a flat rate (e.g. 2 KWD)
- Outside Kuwait — optional, requires per-country rates

If you ship via a known carrier (Aramex, iCarry), enter your API credentials so tracking numbers auto-update.

أنشئ مناطق الشحن: عادةً منطقة واحدة داخل الكويت برسوم ثابتة. لو تستخدم Aramex أو iCarry، أدخل بيانات حساب التاجر لتحديث أرقام التتبّع تلقائيًا.

## 7. Customize the storefront

**Admin → Page Builder**

The Page Builder is the single destination for all storefront layout decisions. From here you can:

- **Homepage sections** — drag-and-drop to reorder, toggle visibility, edit each section's headline and subheadline (bilingual)
- **Hero banner** — image + headline + CTA
- **Featured categories** — which 4-6 show on the home page
- **Featured products** — which appear in the "Bestsellers" carousel
- **Testimonials** — customer reviews shown on the home page
- **Storefront Navigation** — add, remove, or reorder header navigation links
- **Footer links** — configure footer link groups and social media handles
- **Category pages** — manage how your category grid is displayed

All copy is bilingual.

كل نصوص الواجهة قابلة للتخصيص بالعربية والإنجليزية من لوحة «Page Builder»: البانر الرئيسي، الفئات المميّزة، التقييمات، التنقل، روابط الفوتر، صفحات الفئات.

## 8. Connect a custom domain (optional)

By default your store is at `store.forcemediakw.com/<your-slug>`. To use `yourstore.com`, see [custom-domain.md](./custom-domain.md) — 10 minutes of DNS work + automatic SSL.

افتراضيًا متجرك على `store.forcemediakw.com/<slug>`. لربط `yourstore.com` بدلًا، راجع [custom-domain.md](./custom-domain.md) — 10 دقائق من إعدادات DNS وSSL تلقائي.

## 9. Connect Force WhatsApp Business Platform (optional but recommended)

If you want WhatsApp order notifications or the customer DM ordering bot:

**Admin → Settings → WhatsApp Integration → Connection**

1. Ask your Force AI contact for the Force WhatsApp Business Platform setup — you'll need an active WBS account.
2. In Force Store admin, click **Generate API Key** under the WhatsApp Integration card.
3. Copy the key and paste it into the WBS admin under your store's settings.
4. Once connected, the status chip on the Settings card shows **Connected** in green.

أرسل لفريق Force AI أنك تريد تفعيل واتساب. بعد إنشاء حسابك على منصة WBS، ارجع لـ Admin ← Settings ← WhatsApp Integration وانقر «Generate API Key» ثم الصقها في إعدادات WBS.

### Enable Customer DM Ordering

Once connected:

- **Admin → Settings → WhatsApp Integration → Connection → Customer DM Ordering toggle** → turn ON
- Customers who DM your business WhatsApp number will be guided through your catalog automatically
- The bot speaks Arabic or English — auto-detected from the customer's first message

### Edit Bot Copy

- **Admin → Settings → WhatsApp Integration → Bot Copy**
- Edit the welcome greeting, prompts, and checkout message in Arabic and English
- Changes apply immediately

### View Bot Analytics

- **Admin → Settings → WhatsApp Integration → Bot Analytics**
- Shows the funnel (how many DMs reached checkout vs. paid), intent breakdown, and date ranges
- Use this to see which hours/days get the most bot orders

---

## 10. Test a real order before going live

1. Open your storefront as a visitor (incognito browser tab)
2. Add a product to cart
3. Checkout with Cash on Delivery (or a test card if you set up a payment provider in **test mode**)
4. Confirm:
   - Order appears in **Admin → Orders** within ~5 seconds
   - You received the order email (check spam folder)
   - The customer sees the success page

اطلب طلب اختبار من الواجهة كزائر (تبويب خاص) قبل الإطلاق الرسمي. تأكد أن الطلب يظهر في لوحة الإدارة + وصلك إيميل الإشعار.

## 11. Go live

Switch your payment providers from **test mode** to **live mode** in **Admin → Settings → Payment Settings**. Real customer payments will now go to your bank account.

في إعدادات الدفع، حوّل بوابة الدفع من «وضع الاختبار» إلى «الوضع المباشر». من الآن المدفوعات الحقيقية ستذهب لحسابك البنكي.

---

**That's it. متجرك جاهز.**

Next steps:

- Send the store URL to your customers
- Monitor orders in **Admin → Orders**
- Reply to customer reviews in **Admin → Reviews**
- Use **Admin → Analytics** to track conversion + bestsellers

ارسل رابط متجرك للعملاء، تابع الطلبات والتقييمات من لوحة الإدارة، استخدم لوحة التحليلات لمعرفة أكثر المنتجات مبيعًا.
