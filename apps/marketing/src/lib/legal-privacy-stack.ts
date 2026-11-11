/**
 * The privacy policy's sections 5 (service providers) and 6 (transfers abroad) for the stack AFTER the Cloudflare
 * cutover (DOC-2): Cloudflare is the infrastructure and data processor (database, queues and jobs, email, file storage,
 * AI inference); Neon, Resend and Inngest are gone. legal-{en,ar}.ts render these when `PRIVACY_STACK` (packages/shared
 * /src/legal) is 'cloudflare', and the current-stack text otherwise. Flipping the switch is part of the cutover PR and
 * needs the matching LEGAL_POLICIES entry (privacy >= 1.2, material): tests/unit/privacy-stack-switch.test.ts fails otherwise.
 * Kashier appears only once card payments are enabled; until then plans are paid by InstaPay (Ruling: InstaPay is the
 * launch payment method) and we hold only the payment reference.
 */
export const POST_CUTOVER = {
  en: {
    providers: [
      'We use these providers to run the Service. Each processes data only on our instructions and under its own security and data terms: Cloudflare, our infrastructure and data processor (website and API hosting and delivery, the database and file and image storage, queues and scheduled jobs, transactional and campaign email, and AI inference on Workers AI); Sentry (error and performance monitoring, EU region); Google Gemini (Google; AI features where a merchant uses them: only the text you submit to an AI feature is sent); PostHog (EU cloud; product analytics in the merchant dashboard and, with your consent, the sign-up funnel); Meta (advertising measurement of our own ads, only with your consent); OneSignal (United States; push notifications to the merchant dashboard installed as a home-screen app); and Kashier (card payment processing, once card payments are enabled; until then plans are paid by InstaPay and we hold only the payment reference).',
      'When a merchant uses Ebda Chat, Meta Platforms (WhatsApp) also receives the messages and related data needed to send and receive them, as an independent controller under its own terms; see the Ebda Chat Privacy Policy (https://ebda.app/en/legal/whatsapp-privacy/).',
      'We may add or replace providers; the current list is maintained on this page. We do not sell personal data.',
    ],
    transfers: [
      'Cloudflare runs a global network, so data may be processed or stored outside Egypt. Where the law requires, we rely on appropriate contractual and technical safeguards, and we choose EU regions for the error-monitoring and analytics services above. The recipients outside Egypt are the providers listed in section 5 (Cloudflare, Sentry, Google, PostHog, Meta and OneSignal, in the EU, the United States or both) and, for Ebda Chat, Meta.',
    ],
  },
  ar: {
    providers: [
      'نستعين بالمزودين التاليين لتشغيل الخدمة، ويعالج كل منهم البيانات وفق تعليماتنا وشروطه الأمنية وشروط البيانات الخاصة به: Cloudflare، مزوّد البنية التحتية والمعالج الرئيسي للبيانات لدينا (استضافة الموقع وواجهة البرمجة وتوصيلهما، وقاعدة البيانات وتخزين الملفات والصور، والطوابير والمهام المجدولة، والبريد الإلكتروني للخدمة والحملات، والاستدلال بالذكاء الاصطناعي عبر Workers AI)؛ Sentry (مراقبة الأخطاء والأداء، منطقة الاتحاد الأوروبي)؛ Google Gemini (Google؛ ميزات الذكاء الاصطناعي حيث يستخدمها التاجر: لا يُرسل إلا النص الذي تدخله في الميزة)؛ PostHog (سحابة الاتحاد الأوروبي؛ تحليلات المنتج في لوحة التاجر ومسار التسجيل بموافقتك)؛ Meta (قياس إعلاناتنا نحن، وبموافقتك فقط)؛ OneSignal (الولايات المتحدة؛ الإشعارات الفورية للوحة التاجر المثبّتة كتطبيق على الشاشة الرئيسية)؛ وKashier (معالجة مدفوعات البطاقات عند تفعيلها؛ وإلى ذلك الحين تُسدَّد الخطط عبر إنستاباي ولا نحتفظ إلا بمرجع الدفع).',
      'وإذا استخدم التاجر ابدأ شات فإن Meta Platforms (واتساب) تستلم أيضًا الرسائل والبيانات المرتبطة بها اللازمة لإرسالها واستقبالها، بصفتها متحكّمًا مستقلًا وفق شروطها؛ راجع سياسة الخصوصية الخاصة بخدمة ابدأ شات (https://ebda.app/legal/whatsapp-privacy/).',
      'قد نضيف مزودين أو نستبدلهم، وتُحدَّث القائمة الحالية في هذه الصفحة. ولا نبيع البيانات الشخصية.',
    ],
    transfers: [
      'تشغّل Cloudflare شبكة عالمية، لذا قد تُعالج البيانات أو تُخزَّن خارج مصر. وحيث يوجب القانون نعتمد ضمانات تعاقدية وتقنية مناسبة، ونختار مناطق الاتحاد الأوروبي لخدمتَي مراقبة الأخطاء والتحليلات المذكورتين أعلاه. والجهات المستلمة خارج مصر هي المزودون المذكورون في البند 5 (Cloudflare وSentry وGoogle وPostHog وMeta وOneSignal، في الاتحاد الأوروبي أو الولايات المتحدة أو كليهما)، وMeta في حالة ابدأ شات.',
    ],
  },
} as const;
