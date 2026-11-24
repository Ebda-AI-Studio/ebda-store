'use client';

import { CmsPageContent, ShopChrome } from '../../components';
import { useStore, useStoreContact } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { formatDate } from '../../lib/format-date';

// This fallback copy's content last materially changed in commit 9364a5c3
// ("fix: remediate builder reality audit findings ... legal", 2026-07-09,
// PR #523 §Lens D) — the PostHog/Sentry/OneSignal/Resend/data-retention
// section below. `formatDate(new Date(), ...)` rendered "today" on every
// page load regardless, a false attestation that the policy is currently
// under review (C1-2 in the 2026-09-22 AEO audit). Update this constant in
// the SAME commit as any future edit to the copy below.
const PRIVACY_FALLBACK_LAST_UPDATED = new Date('2026-07-09T00:00:00Z');

/**
 * Legacy hardcoded Privacy Policy. Used as a fallback when the merchant
 * hasn't authored a `privacy` row in the Pages CMS — preserves the
 * boutique-grade copy that shipped pre-CMS so existing stores don't
 * regress overnight while merchants migrate.
 */
function PrivacyFallback() {
  const { email } = useStoreContact();
  const { t, language } = useLanguage();
  const { store } = useStore();
  const privacyEmail = email || t('our support team', 'فريق الدعم');
  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6 lg:px-8">
      <div className="text-center">
        <h1 className="text-3xl font-bold text-foreground">
          {t('Privacy Policy', 'سياسة الخصوصية')}
        </h1>
        <p className="mt-2 text-muted-foreground">
          {t('Last updated:', 'آخر تحديث:')}{' '}
          {formatDate(PRIVACY_FALLBACK_LAST_UPDATED, {
            timezone: store.timezone,
            language,
            style: 'long',
          })}
        </p>
      </div>

      <div className="mt-12 rounded-xl border bg-card p-6 shadow-sm sm:p-8">
        <div className="prose prose-gray max-w-none">
          <section className="mb-8">
            <h2 className="text-xl font-semibold text-foreground">
              {t('1. Information We Collect', '1. المعلومات التي نجمعها')}
            </h2>
            <p className="mt-2 text-muted-foreground">
              {t(
                'We collect information you provide directly to us, including:',
                'نجمع المعلومات التي تقدمها لنا مباشرة، بما في ذلك:'
              )}
            </p>
            <ul className="mt-2 list-disc space-y-1 ps-5 text-muted-foreground">
              <li>
                {t(
                  'Name, email address, and contact information',
                  'الاسم والبريد الإلكتروني ومعلومات الاتصال'
                )}
              </li>
              <li>{t('Billing and shipping addresses', 'عناوين الفواتير والشحن')}</li>
              <li>
                {t(
                  'Payment information (processed securely via our payment gateway)',
                  'معلومات الدفع (تتم معالجتها بأمان عبر بوابة الدفع)'
                )}
              </li>
              <li>{t('Order history and preferences', 'سجل الطلبات والتفضيلات')}</li>
              <li>{t('Communications with our support team', 'التواصل مع فريق الدعم')}</li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-xl font-semibold text-foreground">
              {t('2. How We Use Your Information', '2. كيف نستخدم معلوماتك')}
            </h2>
            <p className="mt-2 text-muted-foreground">
              {t('We use the information we collect to:', 'نستخدم المعلومات التي نجمعها من أجل:')}
            </p>
            <ul className="mt-2 list-disc space-y-1 ps-5 text-muted-foreground">
              <li>{t('Process and fulfill your orders', 'معالجة وتنفيذ طلباتك')}</li>
              <li>
                {t(
                  'Send order confirmations and shipping updates',
                  'إرسال تأكيدات الطلب وتحديثات الشحن'
                )}
              </li>
              <li>{t('Respond to your questions and requests', 'الرد على أسئلتك وطلباتك')}</li>
              <li>{t('Improve our products and services', 'تحسين منتجاتنا وخدماتنا')}</li>
              <li>
                {t(
                  'Send promotional communications (with your consent)',
                  'إرسال اتصالات ترويجية (بموافقتك)'
                )}
              </li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-xl font-semibold text-foreground">
              {t('3. Information Sharing', '3. مشاركة المعلومات')}
            </h2>
            <p className="mt-2 text-muted-foreground">
              {t(
                'We do not sell your personal information. We may share your information with:',
                'لا نبيع معلوماتك الشخصية. قد نشارك معلوماتك مع:'
              )}
            </p>
            <ul className="mt-2 list-disc space-y-1 ps-5 text-muted-foreground">
              <li>
                {t(
                  'Service providers who assist in our operations (payment processing, shipping)',
                  'مقدمي الخدمات الذين يساعدون في عملياتنا (معالجة الدفع، الشحن)'
                )}
              </li>
              <li>
                {t('Law enforcement when required by law', 'جهات إنفاذ القانون عند الاقتضاء')}
              </li>
              <li>
                {t(
                  'Business partners with your explicit consent',
                  'شركاء الأعمال بموافقتك الصريحة'
                )}
              </li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-xl font-semibold text-foreground">
              {t('4. Data Security', '4. أمان البيانات')}
            </h2>
            <p className="mt-2 text-muted-foreground">
              {t(
                'We implement appropriate security measures to protect your personal information, including:',
                'نطبق إجراءات أمنية مناسبة لحماية معلوماتك الشخصية، بما في ذلك:'
              )}
            </p>
            <ul className="mt-2 list-disc space-y-1 ps-5 text-muted-foreground">
              <li>
                {t(
                  'SSL encryption for all data transmission',
                  'تشفير SSL لجميع عمليات نقل البيانات'
                )}
              </li>
              <li>
                {t(
                  'Secure payment processing through our payment providers',
                  'معالجة دفع آمنة من خلال مزودي الدفع لدينا'
                )}
              </li>
              <li>
                {t('Regular security audits and updates', 'عمليات تدقيق وتحديثات أمنية منتظمة')}
              </li>
              <li>
                {t(
                  'Limited access to personal information by employees',
                  'وصول محدود للموظفين إلى المعلومات الشخصية'
                )}
              </li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-xl font-semibold text-foreground">
              {t('5. Cookies', '5. ملفات تعريف الارتباط')}
            </h2>
            <p className="mt-2 text-muted-foreground">
              {t(
                'We use cookies and similar technologies to:',
                'نستخدم ملفات تعريف الارتباط والتقنيات المماثلة من أجل:'
              )}
            </p>
            <ul className="mt-2 list-disc space-y-1 ps-5 text-muted-foreground">
              <li>{t('Keep you logged in to your account', 'إبقائك مسجلاً في حسابك')}</li>
              <li>{t('Remember your cart contents', 'تذكر محتويات سلتك')}</li>
              <li>{t('Analyze site traffic and usage', 'تحليل حركة المرور واستخدام الموقع')}</li>
              <li>{t('Personalize your shopping experience', 'تخصيص تجربة التسوق الخاصة بك')}</li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-xl font-semibold text-foreground">
              {t('6. Third-Party Services We Use', '6. خدمات الجهات الخارجية التي نستخدمها')}
            </h2>
            <p className="mt-2 text-muted-foreground">
              {t(
                'We rely on trusted third-party providers to operate this store. Each processes only the data needed for its function, under its own privacy policy:',
                'نعتمد على مزودي خدمات موثوقين من جهات خارجية لتشغيل هذا المتجر. يعالج كل منهم البيانات اللازمة لأداء وظيفته فقط، وفقاً لسياسة الخصوصية الخاصة به:'
              )}
            </p>
            <ul className="mt-2 list-disc space-y-1 ps-5 text-muted-foreground">
              <li>
                {t(
                  'Payment gateways (such as Paymob, Kashier, or Fawry) — to process your payments securely. We never store your full card details.',
                  'بوابات الدفع (مثل باي موب أو كاشير أو فوري) — لمعالجة مدفوعاتك بأمان. لا نقوم مطلقاً بتخزين تفاصيل بطاقتك كاملة.'
                )}
              </li>
              <li>
                {t(
                  'PostHog (product analytics, hosted in the European Union) — anonymous usage analytics to improve the store. Your IP address is not collected.',
                  'PostHog (تحليلات المنتج، مستضافة في الاتحاد الأوروبي) — تحليلات استخدام مجهولة الهوية لتحسين المتجر. لا يتم جمع عنوان IP الخاص بك.'
                )}
              </li>
              <li>
                {t(
                  'Sentry (error monitoring) — to detect and fix technical problems. It does not receive your account profile.',
                  'Sentry (مراقبة الأخطاء) — لاكتشاف المشكلات التقنية وإصلاحها. لا يستقبل ملف حسابك الشخصي.'
                )}
              </li>
              <li>
                {t(
                  'Browser push notifications (Web Push) — to send order and promotional notifications, only if you opt in.',
                  'إشعارات المتصفح (Web Push) — لإرسال إشعارات الطلبات والعروض الترويجية، فقط إذا اخترت ذلك.'
                )}
              </li>
              <li>
                {t(
                  'Cloudflare Email Service (email delivery) — to send transactional emails such as order confirmations and password resets.',
                  'Cloudflare Email Service (تسليم البريد الإلكتروني) — لإرسال رسائل البريد الإلكتروني المعاملاتية مثل تأكيدات الطلبات وإعادة تعيين كلمة المرور.'
                )}
              </li>
              <li>
                {t(
                  "Cloudflare and Neon (hosting & infrastructure) — to host the store, deliver content securely, and store your account and order data. Neon's database is hosted in Frankfurt, Germany (EU).",
                  'Cloudflare و Neon (الاستضافة والبنية التحتية) — لاستضافة المتجر وتسليم المحتوى بأمان وتخزين بيانات حسابك وطلباتك. تُستضاف قاعدة بيانات Neon في فرانكفورت، ألمانيا (الاتحاد الأوروبي).'
                )}
              </li>
            </ul>
            <p className="mt-3 text-muted-foreground">
              {t(
                "International transfers: some providers (for example, PostHog and Neon) process data on servers in the European Union — Neon's database specifically is in Frankfurt, Germany. We choose providers with strong, recognized data-protection standards.",
                'عمليات النقل الدولية: يعالج بعض المزودين (مثل PostHog و Neon) البيانات على خوادم في الاتحاد الأوروبي — وتحديداً تُستضاف قاعدة بيانات Neon في فرانكفورت، ألمانيا. نختار مزودين يلتزمون بمعايير قوية ومعترف بها لحماية البيانات.'
              )}
            </p>
            <p className="mt-2 text-muted-foreground">
              {t(
                'Data retention: we keep your information for as long as your account is active or as needed to provide our services and meet legal obligations (such as Egyptian commercial and tax record-keeping requirements).',
                'الاحتفاظ بالبيانات: نحتفظ بمعلوماتك طالما ظل حسابك نشطاً أو حسب الحاجة لتقديم خدماتنا والوفاء بالالتزامات القانونية (مثل متطلبات حفظ السجلات التجارية والضريبية في مصر).'
              )}
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-xl font-semibold text-foreground">
              {t('7. Your Rights', '7. حقوقك')}
            </h2>
            <p className="mt-2 text-muted-foreground">
              {t('You have the right to:', 'لديك الحق في:')}
            </p>
            <ul className="mt-2 list-disc space-y-1 ps-5 text-muted-foreground">
              <li>{t('Access your personal information', 'الوصول إلى معلوماتك الشخصية')}</li>
              <li>{t('Correct inaccurate information', 'تصحيح المعلومات غير الدقيقة')}</li>
              <li>{t('Request deletion of your data', 'طلب حذف بياناتك')}</li>
              <li>
                {t('Opt out of marketing communications', 'إلغاء الاشتراك في الاتصالات التسويقية')}
              </li>
              <li>
                {t('Export your data in a portable format', 'تصدير بياناتك بتنسيق قابل للنقل')}
              </li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-xl font-semibold text-foreground">
              {t('8. Contact Us', '8. تواصل معنا')}
            </h2>
            <p className="mt-2 text-muted-foreground">
              {t(
                'If you have any questions about this Privacy Policy, please contact us at:',
                'إذا كان لديك أي أسئلة حول سياسة الخصوصية هذه، يرجى التواصل معنا على:'
              )}
            </p>
            <p className="mt-2 text-muted-foreground">
              {t('Email:', 'البريد الإلكتروني:')} {privacyEmail}
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

export default function PrivacyClient() {
  return (
    <ShopChrome>
      <CmsPageContent
        slug="privacy"
        defaultTitle={{ en: 'Privacy Policy', ar: 'سياسة الخصوصية' }}
        fallback={() => <PrivacyFallback />}
      />
    </ShopChrome>
  );
}
