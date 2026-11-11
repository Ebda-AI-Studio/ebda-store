import type { LegalDoc } from './legal-types';

/**
 * The refund and cancellation policy (/refund/, BIZ-25 / M-034): it RESTATES what the Terms of Service (sections 4, 13)
 * and the Merchant Agreement (section 11) already say about Ebda Store's own subscriptions, and points at the Ebda Chat
 * terms for the wallet. It adds no new promise. It stands as our policy from launch (Ahmad 2026-11-10, Ruling LEGAL-FINAL-1:
 * no "provisional" note); change it together with the Terms, never alone.
 */
const META = { version: '1.1', publishedAt: '2026-11-10' } as const;

export const REFUND_EN: LegalDoc = {
  title: 'Refund and cancellation policy',
  meta: META,
  note: 'This policy restates the refund terms of the Terms of Service and the Merchant Agreement. If it differs from those documents, they prevail.',
  sections: [
    {
      h: '1. Cancelling',
      p: [
        'You can cancel your subscription at any time from the subscription page in the dashboard. Cancelling stops future charges. It does not refund charges already made.',
      ],
    },
    {
      h: '2. The free trial',
      p: [
        'A new store can try the Growth plan free for 14 days. Nothing is charged during the trial. When it ends, the store moves to a paid plan only if you choose a plan and pay for it.',
      ],
    },
    {
      h: '3. Paid subscriptions',
      p: [
        'Subscription fees (monthly or yearly) are charged in advance and are not refundable, including for partial periods, downgrades, unused time (including the rest of a yearly term) and closure of the account. The exceptions are the two below.',
      ],
    },
    {
      h: '4. What we do refund or correct',
      p: [
        'Where mandatory law requires a refund, we refund. Where we charged you in error (for example a duplicate charge), we correct the error. Write to ahlan@ebda.app with the payment reference and we will answer in writing.',
      ],
    },
    {
      h: '5. Ebda Chat wallet',
      p: [
        'Wallet balances and refunds of Ebda Chat follow section 6.5 of the Ebda Chat Terms of Service (https://ebda.app/en/legal/whatsapp-terms/).',
      ],
    },
    {
      h: '6. Your statutory rights',
      p: [
        'Nothing in this policy limits a right you have under mandatory law, including the Consumer Protection Law No. 181 of 2018 where it applies.',
      ],
    },
    {
      h: '7. Prices and VAT',
      p: [
        'Prices and VAT. All prices are final amounts in Egyptian pounds. We are not registered for value-added tax (VAT) and therefore charge none. If we become registered, VAT will be introduced only after at least 30 days of written notice, as a change to fees, will be shown as a separate line, and will never apply retroactively to any amount already paid or invoiced.',
      ],
    },
  ],
};

export const REFUND_AR: LegalDoc = {
  title: 'سياسة الاسترداد والإلغاء',
  meta: META,
  note: 'تعيد هذه السياسة صياغة أحكام الاسترداد الواردة في شروط الخدمة واتفاقية التاجر. وإذا اختلفت عن تلك الوثائق فالعبرة بها.',
  sections: [
    {
      h: '1. الإلغاء',
      p: [
        'يمكنك إلغاء اشتراكك في أي وقت من صفحة الاشتراك في لوحة التحكم. ويوقف الإلغاء الخصم مستقبلًا، ولا يسترد ما سبق خصمه.',
      ],
    },
    {
      h: '2. التجربة المجانية',
      p: [
        'للمتجر الجديد تجربة مجانية لخطة النمو مدتها 14 يومًا، لا يُحصَّل فيها أي مبلغ. وبعد انتهائها لا ينتقل المتجر إلى خطة مدفوعة إلا إذا اخترت خطة وسدّدت قيمتها.',
      ],
    },
    {
      h: '3. الاشتراكات المدفوعة',
      p: [
        'تُحصَّل رسوم الاشتراك (شهريًا أو سنويًا) مقدمًا ولا تُسترد، بما في ذلك الفترات الجزئية وخفض الخطة والمدة غير المستخدمة (ومنها باقي المدة السنوية) وإغلاق الحساب. والاستثناءان هما الواردان أدناه.',
      ],
    },
    {
      h: '4. ما نردّه أو نصحّحه',
      p: [
        'حيث يوجب القانون الآمر الاسترداد فإننا نسترد. وحيث حصّلنا منك مبلغًا بالخطأ (كخصم مكرر) فإننا نصحّح الخطأ. راسلنا على ahlan@ebda.app مع مرجع الدفع وسنرد كتابةً.',
      ],
    },
    {
      h: '5. محفظة ابدأ شات',
      p: [
        'أرصدة محفظة ابدأ شات واستردادها وفق البند 6.5 من شروط خدمة ابدأ شات (https://ebda.app/legal/whatsapp-terms/).',
      ],
    },
    {
      h: '6. حقوقك النظامية',
      p: [
        'لا تقيّد هذه السياسة أي حق لك بموجب القانون الآمر، ومنه قانون حماية المستهلك رقم 181 لسنة 2018 حيث يسري.',
      ],
    },
    {
      h: '7. الأسعار والضريبة',
      p: [
        'الأسعار والضريبة. جميع الأسعار مبالغ نهائية بالجنيه المصري. نحن غير مسجّلين في ضريبة القيمة المضافة ولذلك لا نحصّلها. وإذا تم تسجيلنا فلن تُطبَّق الضريبة إلا بعد إشعار كتابي لا تقل مدته عن 30 يومًا، باعتبارها تعديلًا في الرسوم، وتُعرض بندًا منفصلًا، ولا تسري بأثر رجعي على أي مبلغ سبق سداده أو إصدار فاتورة به.',
      ],
    },
  ],
};
