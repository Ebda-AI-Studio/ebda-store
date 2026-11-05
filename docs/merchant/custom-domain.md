# Custom Domain Setup — ربط النطاق المخصص

Point `yourstore.com` at Ebda Store in ~10 minutes. ربط نطاقك بالمتجر خلال 10 دقائق.

## What you need

- A domain you own (registered at GoDaddy, Namecheap, Cloudflare, etc.)
- Access to your domain registrar's DNS panel
- Ebda Store admin access

نطاق مسجّل، صلاحية تعديل DNS، صلاحية لوحة الإدارة.

## Step 1 — Add the domain in Admin

**Admin → Settings → Custom Domain**

The page now tells apart three states: **"Waiting for DNS to update"** (records not seen yet), **"The domain does not point to your store yet"** (ownership confirmed but the records still go elsewhere) and **"Email records are still missing"**. "Copy all records" and "Email these instructions" help you hand the records to whoever manages the domain. Removing the domain asks for a confirmation first.

- Click **Add Custom Domain**
- Type your domain: `yourstore.com` (without `https://` or `www.`)
- Click **Save**

The admin will show you two DNS records to add. Keep this page open.

ستظهر سجلات DNS التي يجب إضافتها — أبقِ الصفحة مفتوحة.

## Step 2 — Add the DNS records at your registrar

Ebda Store uses Cloudflare-for-SaaS for SSL provisioning — one CNAME record for your domain (the same record works for an apex domain or a subdomain). The admin will show you the exact value, but it looks like:

| Type    | Name                    | Value         | TTL  |
| ------- | ----------------------- | ------------- | ---- |
| `CNAME` | `@` (or your subdomain) | `cf.ebda.app` | 3600 |

The `www` variant is enrolled automatically alongside your domain — you don't need a separate record for it.

**At your registrar (e.g. GoDaddy / Namecheap / Cloudflare):**

1. Find the DNS management panel (often labeled "DNS Records", "DNS Settings", or "Manage DNS")
2. Delete any existing `A` record on `@` if present (it's usually the registrar's default parking page)
3. Add the CNAME record from the table above
4. **If you use Cloudflare**: set the proxy status to **DNS-only** (gray cloud), NOT Proxied (orange cloud). Ebda Store needs to verify the domain directly.

أضف السجلات عند جهة تسجيل النطاق (GoDaddy / Namecheap / Cloudflare). لو تستخدم Cloudflare، أبقِ الـ proxy على "DNS only" (سحابة رمادية).

## Step 3 — Verify

Back in **Admin → Settings → Custom Domain**:

- Click **Verify Now**
- The status changes from `pending` to `verifying` (DNS propagation — usually 1-5 minutes, max 24h)
- Once verified, status changes to `active` and Ebda Store auto-issues an SSL certificate (Let's Encrypt)

ارجع للوحة الإدارة واضغط «تحقّق الآن». الحالة ستتغيّر تدريجيًا: `pending` → `verifying` → `active`. شهادة SSL تُصدر تلقائيًا.

## Step 4 — Update your payment provider's return URL

If you set up a payment provider before adding the custom domain, the success/error return URLs still point to your old `store.ebda.app/<slug>` URL. Update them in each provider's merchant dashboard:

- Success URL: `https://yourstore.com/checkout/success`
- Error URL: `https://yourstore.com/checkout/error`

The webhook URL stays the same — it always points at `api.ebda.app` regardless of your custom domain (`api.ebda.app` also still works during migration).

في لوحة مزوّد الدفع، حدّث روابط النجاح والخطأ لتشير لنطاقك الجديد. رابط webhook لا يتغيّر (دائمًا `api.ebda.app` — والنطاق القديم `api.ebda.app` يعمل خلال فترة التحويل).

## Verification checklist

- [ ] `https://yourstore.com` opens the storefront (not the registrar parking page)
- [ ] `https://www.yourstore.com` redirects to `https://yourstore.com` (or vice versa, your preference)
- [ ] The padlock icon shows in the browser address bar (SSL is working)
- [ ] Adding a product to cart + checking out works end-to-end
- [ ] Payment provider success URLs return you to `yourstore.com`, not the old URL

## Common issues — مشاكل شائعة

**"DNS hasn't propagated yet"**
DNS changes can take up to 24h to propagate globally, though Cloudflare-hosted DNS usually resolves in <5 min. Use <https://dnschecker.org/?type=CNAME&domain=yourstore.com> to see if the record is visible from different regions. Wait an hour and click Verify again.

**"Certificate is still pending"**
Let's Encrypt issuance usually completes in 1-5 minutes after DNS verification. If it's been > 30 minutes, contact support — there may be a CAA record on your domain blocking Let's Encrypt.

**"Site loads but shows an error page"**
Your DNS resolved correctly but the domain isn't yet linked to your Ebda Store account internally. Wait 2-3 minutes after clicking Verify; if still broken contact support.

**"Cloudflare orange-cloud breaks SSL"**
If you proxy DNS through Cloudflare (orange cloud), Ebda Store can't verify the domain because Cloudflare presents its own SSL. Switch to "DNS only" (gray cloud) until verification completes; you can re-enable proxy afterwards if you want Cloudflare's CDN, but you'll lose Ebda Store's own caching layer.

لو ما حصلت تحقّق من النطاق: تأكد إن DNS انتشر (استخدم dnschecker.org)، تأكد إن Cloudflare على DNS-only لا Proxied، تأكد ما في CAA record يمنع Let's Encrypt.

## Rolling back

To remove a custom domain:

1. **Admin → Settings → Custom Domain → Remove**
2. The storefront becomes available again at `store.ebda.app/<your-slug>`
3. Delete the A/CNAME records at your registrar (or repoint them at a different host)

لإلغاء نطاق مخصص: ادخل لوحة الإدارة، اضغط «إزالة». المتجر يرجع لنطاق Ebda Store الافتراضي. لا تنسَ حذف سجلات DNS من جهة تسجيل النطاق.
