import type { LegalDoc } from './legal-types';

/**
 * The data deletion page (/legal/data-deletion/): how to ask for erasure or export. It describes what the product
 * and docs/RETENTION.md really do (self-serve erasure, merchant-initiated customer erase and export, 90-day store
 * deletion in the Privacy Policy, 30-day backups). Version and date are its own; change them with any edit.
 */
const META = { version: '1.1', publishedAt: '2026-10-29' } as const;

export const DELETION_EN: LegalDoc = {
  title: 'Data deletion and export',
  meta: META,
  sections: [
    {
      h: '1. Who this page is for',
      p: [
        "Merchants who run an Ebda Store, shoppers who bought from one, and customers whose WhatsApp messages a merchant handles with Ebda WhatsApp. It explains how to ask us to delete (erase) or hand over (export) personal data under Egypt's Personal Data Protection Law No. 151 of 2020. Write to privacy@ebda.app (our data protection officer's address) for anything below.",
      ],
    },
    {
      h: '2. If you are a shopper',
      p: [
        'The merchant you bought from is responsible for your order data (name, phone, address, order history). Ask that merchant first; if you write to us instead, we pass your request to the merchant and tell you we did.',
        'If you have an account that you created while shopping, you can erase it yourself: open your account and choose "Delete my data". It takes effect when you confirm. Your name, contact details and addresses are removed or anonymised, and every device is signed out.',
      ],
    },
    {
      h: '3. If you are a merchant',
      p: [
        "Your customers: open the customer in your dashboard to export or erase their data (store owners and admins only; erasing asks you to confirm by typing). You are the controller of your customers' data, so you answer their requests; we help on reasonable request.",
        'Your store or account: write to privacy@ebda.app from the email address on the account and say that you want the store and its data deleted. We delete or anonymise the store and its data within 90 days of the request, except what is listed in section 6.',
      ],
    },
    {
      h: '4. Asking for a copy (export)',
      p: [
        "Write to privacy@ebda.app and say which data you want. We send a copy of the personal data we hold about you in a common electronic format. Customers of a merchant's store should ask the merchant, who holds that data.",
      ],
    },
    {
      h: '5. How we check it is you, and how long it takes',
      p: [
        'We reply from or to the email address or phone number on the account, and may ask one more question before acting. We do not act on a request we cannot link to the person asking.',
        'We answer every request in writing. Erasure through your account or dashboard takes effect at once. Deleting a whole store or account is finished within 90 days of your request.',
      ],
    },
    {
      h: '6. What we keep',
      p: [
        'Billing, tax and other financial records that the law requires us to keep; audit and security logs; and material we need to prevent fraud or to defend a legal claim. We keep these only as long as necessary and use them for nothing else.',
      ],
    },
    {
      h: '7. Backups',
      p: [
        'Backups are copies taken before your request. We do not edit them; they expire on the backup cycle, which keeps copies for 30 days. After that, no copy of the erased data remains with us, except what section 6 lists.',
      ],
    },
    {
      h: '8. Ebda WhatsApp',
      p: [
        "A merchant who deletes a contact removes its data from the live workspace, including stored message text. When a merchant's account ends, the workspace data is deleted within 30 days. Customers can stop marketing messages at any time by replying STOP.",
        'If you connected WhatsApp through Meta and later remove the Ebda app from your Facebook or Meta settings, Meta sends us a signed deletion request automatically. We erase the link between your Meta account and Ebda, and give you a confirmation code to check the status of the request. This does not delete a merchant workspace; for that, write to privacy@ebda.app.',
        'WhatsApp is run by Meta Platforms, which keeps its own copy under its own policy. To erase what Meta holds, ask Meta directly. The Ebda WhatsApp Privacy Policy and Data Processing Agreement give the details.',
      ],
    },
    {
      h: '9. Complaints',
      p: [
        'If you are not satisfied with our answer, write to privacy@ebda.app, and you may complain to the Personal Data Protection Centre in Egypt.',
      ],
    },
  ],
};

export const DELETION_AR: LegalDoc = {
  title: 'حذف البيانات وتصديرها',
  meta: META,
  sections: [
    {
      h: '1. لمن هذه الصفحة',
      p: [
        'للتجار الذين يديرون متجرًا على ابدأ ستور، وللمتسوقين الذين اشتروا من متجر، ولعملاء التاجر الذين يتعامل التاجر مع رسائلهم على واتساب عبر ابدأ واتساب. وتشرح كيف تطلب منا حذف بياناتك الشخصية أو تسليمك نسخة منها بموجب قانون حماية البيانات الشخصية المصري رقم 151 لسنة 2020. راسلنا على privacy@ebda.app (بريد مسؤول حماية البيانات لدينا) في أي مما يلي.',
      ],
    },
    {
      h: '2. إذا كنت متسوقًا',
      p: [
        'التاجر الذي اشتريت منه هو المسؤول عن بيانات طلبك (الاسم والهاتف والعنوان وسجل الطلبات). اطلب منه أولًا؛ وإذا راسلتنا نحن أحلنا طلبك إلى التاجر وأخبرناك بذلك.',
        'وإذا كان لديك حساب أنشأته أثناء التسوق فيمكنك حذفه بنفسك: افتح حسابك واختر «حذف بياناتي». ويسري ذلك بمجرد تأكيدك. تُزال أو تُجعل مجهولة الهوية بياناتك من اسم وبيانات تواصل وعناوين، ويُسجَّل خروج كل الأجهزة.',
      ],
    },
    {
      h: '3. إذا كنت تاجرًا',
      p: [
        'عملاؤك: افتح العميل في لوحة التحكم لتصدير بياناته أو حذفها (لمالكي المتاجر ومديريها فقط، ويطلب الحذف تأكيدًا بالكتابة). أنت المتحكّم في بيانات عملائك فتجيب أنت عن طلباتهم، ونساعدك عند الطلب المعقول.',
        'متجرك أو حسابك: راسلنا على privacy@ebda.app من البريد المسجّل في الحساب واذكر أنك تريد حذف المتجر وبياناته. نحذف المتجر وبياناته أو نجعلها مجهولة الهوية خلال 90 يومًا من الطلب، عدا ما ورد في البند 6.',
      ],
    },
    {
      h: '4. طلب نسخة من بياناتك (التصدير)',
      p: [
        'راسلنا على privacy@ebda.app واذكر البيانات التي تريدها. نرسل لك نسخة من البيانات الشخصية التي نحتفظ بها عنك بصيغة إلكترونية شائعة. وعلى عملاء المتاجر أن يطلبوا من التاجر الذي يحتفظ بتلك البيانات.',
      ],
    },
    {
      h: '5. كيف نتحقق منك، وكم يستغرق الأمر',
      p: [
        'نرد عبر البريد الإلكتروني أو رقم الهاتف المسجّل في الحساب، وقد نسألك سؤالًا إضافيًا قبل التنفيذ. ولا ننفّذ طلبًا لا نستطيع ربطه بمن قدّمه.',
        'نرد على كل طلب كتابةً. والحذف من حسابك أو من لوحة التحكم يسري فورًا. أما حذف متجر أو حساب كامل فيكتمل خلال 90 يومًا من طلبك.',
      ],
    },
    {
      h: '6. ما نحتفظ به',
      p: [
        'سجلات الفوترة والضرائب وغيرها من السجلات المالية التي يوجب القانون حفظها؛ وسجلات التدقيق والأمن؛ وما نحتاجه لمنع الاحتيال أو للدفاع في مطالبة قانونية. نحتفظ بها بالقدر اللازم فقط ولا نستخدمها في غير ذلك.',
      ],
    },
    {
      h: '7. النسخ الاحتياطية',
      p: [
        'النسخ الاحتياطية نسخ أُخذت قبل طلبك. لا نعدّلها، وتنتهي بدورة النسخ الاحتياطي التي تحتفظ بالنسخ 30 يومًا. وبعد ذلك لا تبقى لدينا أي نسخة من البيانات المحذوفة، عدا ما ورد في البند 6.',
      ],
    },
    {
      h: '8. ابدأ واتساب',
      p: [
        'إذا حذف التاجر جهة اتصال أُزيلت بياناتها من مساحة العمل الحية، بما في ذلك نصوص الرسائل المخزّنة. وعند انتهاء حساب التاجر تُحذف بيانات مساحة العمل خلال 30 يومًا. ويستطيع العملاء إيقاف الرسائل التسويقية في أي وقت بالرد بكلمة STOP.',
        'إذا ربطت واتساب عبر Meta ثم أزلت تطبيق ابدأ من إعدادات فيسبوك أو Meta، ترسل لنا Meta طلب حذف موقّعًا تلقائيًا. نحذف الربط بين حسابك على Meta وابدأ، ونعطيك رمز تأكيد لمتابعة حالة الطلب. ولا يؤدي ذلك إلى حذف مساحة عمل التاجر؛ ولذلك راسلنا على privacy@ebda.app.',
        'واتساب تشغّله Meta Platforms وتحتفظ بنسخة خاصة بها وفق سياستها. ولحذف ما لدى Meta اطلب منها مباشرة. وتفصّل سياسة الخصوصية واتفاقية معالجة البيانات الخاصة بخدمة ابدأ واتساب ذلك.',
      ],
    },
    {
      h: '9. الشكاوى',
      p: [
        'إذا لم يرضك ردّنا فراسلنا على privacy@ebda.app، ويمكنك التقدم بشكوى إلى مركز حماية البيانات الشخصية في مصر.',
      ],
    },
  ],
};
