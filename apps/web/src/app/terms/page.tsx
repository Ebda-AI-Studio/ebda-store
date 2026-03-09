'use client';

import { Header, Footer } from '../../components';
import { useStoreContact } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';

export default function TermsPage() {
  const { email } = useStoreContact();
  const { t } = useLanguage();
  const legalEmail = email || t('our support team', 'فريق الدعم');
  return (
    <main className="flex min-h-screen flex-col bg-gray-50">
      <Header />

      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6 lg:px-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-gray-900">
            {t('Terms of Service', 'الشروط والأحكام')}
          </h1>
          <p className="mt-2 text-gray-500">
            {t('Last updated:', 'آخر تحديث:')}{' '}
            {new Date().toLocaleDateString('en-US', {
              month: 'long',
              day: 'numeric',
              year: 'numeric',
            })}
          </p>
        </div>

        <div className="mt-12 rounded-xl border bg-white p-6 shadow-sm sm:p-8">
          <div className="prose prose-gray max-w-none">
            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900">
                {t('1. Acceptance of Terms', '1. قبول الشروط')}
              </h2>
              <p className="mt-2 text-gray-600">
                {t(
                  'By accessing and using Force Store, you agree to be bound by these Terms of Service. If you do not agree to these terms, please do not use our services.',
                  'باستخدامك لمتجر Force، فإنك توافق على الالتزام بهذه الشروط والأحكام. إذا كنت لا توافق على هذه الشروط، يرجى عدم استخدام خدماتنا.'
                )}
              </p>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900">
                {t('2. Use of Service', '2. استخدام الخدمة')}
              </h2>
              <p className="mt-2 text-gray-600">
                {t(
                  'You agree to use our service only for lawful purposes and in accordance with these Terms. You agree not to:',
                  'توافق على استخدام خدمتنا فقط للأغراض المشروعة ووفقاً لهذه الشروط. توافق على عدم:'
                )}
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-600">
                <li>
                  {t(
                    'Violate any applicable laws or regulations',
                    'انتهاك أي قوانين أو لوائح معمول بها'
                  )}
                </li>
                <li>{t('Infringe on the rights of others', 'التعدي على حقوق الآخرين')}</li>
                <li>
                  {t(
                    'Attempt to gain unauthorized access to our systems',
                    'محاولة الوصول غير المصرح به إلى أنظمتنا'
                  )}
                </li>
                <li>
                  {t('Use the service for fraudulent purposes', 'استخدام الخدمة لأغراض احتيالية')}
                </li>
                <li>
                  {t(
                    'Interfere with the proper functioning of the service',
                    'التدخل في الأداء السليم للخدمة'
                  )}
                </li>
              </ul>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900">
                {t('3. Account Registration', '3. تسجيل الحساب')}
              </h2>
              <p className="mt-2 text-gray-600">
                {t('When you create an account, you agree to:', 'عند إنشاء حساب، فإنك توافق على:')}
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-600">
                <li>
                  {t('Provide accurate and complete information', 'تقديم معلومات دقيقة وكاملة')}
                </li>
                <li>
                  {t(
                    'Maintain the security of your account credentials',
                    'الحفاظ على أمان بيانات حسابك'
                  )}
                </li>
                <li>
                  {t(
                    'Notify us immediately of any unauthorized access',
                    'إخطارنا فوراً بأي وصول غير مصرح به'
                  )}
                </li>
                <li>
                  {t(
                    'Be responsible for all activities under your account',
                    'تحمل المسؤولية عن جميع الأنشطة تحت حسابك'
                  )}
                </li>
              </ul>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900">
                {t('4. Products and Pricing', '4. المنتجات والأسعار')}
              </h2>
              <p className="mt-2 text-gray-600">
                {t(
                  'We strive to provide accurate product information and pricing, but errors may occur. We reserve the right to:',
                  'نسعى لتقديم معلومات دقيقة عن المنتجات والأسعار، ولكن قد تحدث أخطاء. نحتفظ بالحق في:'
                )}
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-600">
                <li>
                  {t(
                    'Correct pricing errors and update information',
                    'تصحيح أخطاء الأسعار وتحديث المعلومات'
                  )}
                </li>
                <li>
                  {t('Limit quantities available for purchase', 'تحديد الكميات المتاحة للشراء')}
                </li>
                <li>{t('Cancel orders affected by errors', 'إلغاء الطلبات المتأثرة بالأخطاء')}</li>
                <li>
                  {t(
                    'Modify or discontinue products without notice',
                    'تعديل أو إيقاف المنتجات دون إشعار'
                  )}
                </li>
              </ul>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900">
                {t('5. Payment Terms', '5. شروط الدفع')}
              </h2>
              <p className="mt-2 text-gray-600">
                {t('By placing an order, you agree that:', 'بتقديم طلب، فإنك توافق على أن:')}
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-600">
                <li>
                  {t(
                    'You are authorized to use the payment method provided',
                    'لديك صلاحية استخدام طريقة الدفع المقدمة'
                  )}
                </li>
                <li>
                  {t('Payment information is accurate and complete', 'معلومات الدفع دقيقة وكاملة')}
                </li>
                <li>
                  {t(
                    'You will pay all charges at the prices in effect when incurred',
                    'ستدفع جميع الرسوم بالأسعار السارية وقت الاستحقاق'
                  )}
                </li>
                <li>
                  {t(
                    'All payments are processed securely through our payment gateway',
                    'تتم معالجة جميع المدفوعات بأمان عبر بوابة الدفع'
                  )}
                </li>
              </ul>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900">
                {t('6. Shipping and Delivery', '6. الشحن والتوصيل')}
              </h2>
              <p className="mt-2 text-gray-600">
                {t(
                  'Shipping times are estimates and not guaranteed. We are not responsible for delays caused by:',
                  'أوقات الشحن تقديرية وغير مضمونة. لسنا مسؤولين عن التأخير الناتج عن:'
                )}
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-600">
                <li>{t('Shipping carrier delays', 'تأخيرات شركة الشحن')}</li>
                <li>
                  {t(
                    'Customs processing for international orders',
                    'إجراءات الجمارك للطلبات الدولية'
                  )}
                </li>
                <li>{t('Incorrect shipping information provided', 'معلومات شحن غير صحيحة')}</li>
                <li>
                  {t('Weather or other unforeseen circumstances', 'الطقس أو ظروف أخرى غير متوقعة')}
                </li>
              </ul>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900">
                {t('7. Returns and Refunds', '7. المرتجعات والاسترداد')}
              </h2>
              <p className="mt-2 text-gray-600">
                {t(
                  'Our return policy allows returns within 30 days of delivery. Please refer to our Returns page for complete details on eligibility and process.',
                  'تسمح سياسة الإرجاع لدينا بالإرجاع خلال 30 يوماً من التوصيل. يرجى الرجوع إلى صفحة المرتجعات لمعرفة التفاصيل الكاملة حول الأهلية والإجراءات.'
                )}
              </p>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900">
                {t('8. Intellectual Property', '8. الملكية الفكرية')}
              </h2>
              <p className="mt-2 text-gray-600">
                {t(
                  'All content on this site, including text, graphics, logos, and software, is the property of Force Media and is protected by intellectual property laws. You may not reproduce, distribute, or create derivative works without our written consent.',
                  'جميع المحتويات على هذا الموقع، بما في ذلك النصوص والرسومات والشعارات والبرامج، هي ملك لـ Force Media ومحمية بقوانين الملكية الفكرية. لا يجوز لك النسخ أو التوزيع أو إنشاء أعمال مشتقة دون موافقتنا الخطية.'
                )}
              </p>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900">
                {t('9. Limitation of Liability', '9. تحديد المسؤولية')}
              </h2>
              <p className="mt-2 text-gray-600">
                {t(
                  'To the maximum extent permitted by law, Force Media shall not be liable for any indirect, incidental, special, or consequential damages arising from your use of our services.',
                  'إلى أقصى حد يسمح به القانون، لن تكون Force Media مسؤولة عن أي أضرار غير مباشرة أو عرضية أو خاصة أو تبعية ناتجة عن استخدامك لخدماتنا.'
                )}
              </p>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900">
                {t('10. Changes to Terms', '10. التغييرات على الشروط')}
              </h2>
              <p className="mt-2 text-gray-600">
                {t(
                  'We reserve the right to modify these terms at any time. Continued use of the service after changes constitutes acceptance of the new terms.',
                  'نحتفظ بالحق في تعديل هذه الشروط في أي وقت. يعد الاستمرار في استخدام الخدمة بعد التغييرات قبولاً للشروط الجديدة.'
                )}
              </p>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900">
                {t('11. Contact Information', '11. معلومات الاتصال')}
              </h2>
              <p className="mt-2 text-gray-600">
                {t(
                  'For questions about these Terms of Service, please contact us at:',
                  'للأسئلة حول هذه الشروط والأحكام، يرجى التواصل معنا على:'
                )}
              </p>
              <p className="mt-2 text-gray-600">
                {t('Email:', 'البريد الإلكتروني:')} {legalEmail}
                <br />
                {t('Address: Kuwait City, Kuwait', 'العنوان: مدينة الكويت، الكويت')}
              </p>
            </section>
          </div>
        </div>
      </div>

      <Footer />
    </main>
  );
}
