import type { Locale } from './site';

/** Copy of the /contact enquiry form: labels, the topic group names, per-field error messages and the result states. */
export interface ContactFormCopy {
  h: string;
  lead: string;
  name: string;
  company: string;
  companyHint: string;
  phone: string;
  phoneHint: string;
  email: string;
  topic: string;
  topicPlaceholder: string;
  topicSupport: string;
  topicServices: string;
  message: string;
  consentBefore: string;
  consentLink: string;
  consentAfter: string;
  submit: string;
  sending: string;
  errorSummary: string;
  errors: Record<
    | 'required'
    | 'too_long'
    | 'too_short'
    | 'invalid_email'
    | 'invalid_phone'
    | 'invalid_topic'
    | 'consent_required',
    string
  >;
  sentH: string;
  sentP: string;
  failed: string;
  tooFast: string;
  rateLimited: string;
}

/** Standalone (no other copy) so the client-side contact form does not bundle the whole site copy. */
export const CONTACT_FORM_COPY: Record<Locale, ContactFormCopy> = {
  ar: {
    h: 'ابعتلنا رسالتك',
    lead: 'قولنا محتاج إيه، وهنرد عليك خلال يوم عمل.',
    name: 'الاسم',
    company: 'الشركة أو المتجر',
    companyHint: 'اختياري',
    phone: 'رقم الموبايل',
    phoneHint: 'مثال: 01012345678',
    email: 'الإيميل',
    topic: 'محتاج إيه؟',
    topicPlaceholder: 'اختار من القايمة',
    topicSupport: 'دعم المنتجات',
    topicServices: 'خدمات الاستوديو',
    message: 'رسالتك',
    consentBefore: 'موافق على ',
    consentLink: 'سياسة الخصوصية',
    consentAfter: ' عشان تتواصلوا معايا بخصوص رسالتي.',
    submit: 'إرسال',
    sending: 'جاري الإرسال…',
    errorSummary: 'في حقول محتاجة تتصلّح:',
    errors: {
      required: 'الحقل ده مطلوب.',
      too_long: 'النص أطول من المسموح.',
      too_short: 'الرسالة قصيرة، اكتب 10 حروف على الأقل.',
      invalid_email: 'اكتب إيميل صحيح، مثلًا name@example.com.',
      invalid_phone: 'اكتب رقم موبايل صحيح، مثلًا 01012345678.',
      invalid_topic: 'اختار حاجة من القايمة.',
      consent_required: 'لازم توافق عشان نقدر نرد عليك.',
    },
    sentH: 'وصلتنا رسالتك',
    sentP: 'هنرد عليك خلال يوم عمل. بعتنالك تأكيد على إيميلك.',
    failed: 'مقدرناش نبعت رسالتك. جرّب واتساب أو ابعتلنا على الإيميل.',
    tooFast: 'استنى لحظة وبعدين ابعت تاني.',
    rateLimited: 'بعتّ رسايل كتير. جرّب بعد شوية، أو كلّمنا على واتساب أو الإيميل.',
  },
  en: {
    h: 'Send us a message',
    lead: 'Tell us what you need and we will reply within one working day.',
    name: 'Name',
    company: 'Company or store',
    companyHint: 'optional',
    phone: 'Mobile number',
    phoneHint: 'For example 01012345678',
    email: 'Email',
    topic: 'What do you need?',
    topicPlaceholder: 'Choose from the list',
    topicSupport: 'Product support',
    topicServices: 'Studio services',
    message: 'Your message',
    consentBefore: 'I agree to the ',
    consentLink: 'privacy policy',
    consentAfter: ' so you can contact me about my message.',
    submit: 'Send',
    sending: 'Sending…',
    errorSummary: 'Some fields need fixing:',
    errors: {
      required: 'This field is required.',
      too_long: 'This is longer than allowed.',
      too_short: 'The message is too short, write at least 10 characters.',
      invalid_email: 'Enter a valid email, for example name@example.com.',
      invalid_phone: 'Enter a valid mobile number, for example 01012345678.',
      invalid_topic: 'Choose an option from the list.',
      consent_required: 'You need to agree so we can reply to you.',
    },
    sentH: 'We got your message',
    sentP: 'We will reply within one working day. We sent a confirmation to your email.',
    failed: 'We could not send your message. Please use WhatsApp or email us instead.',
    tooFast: 'Please wait a moment and send again.',
    rateLimited: 'You have sent a lot of messages. Try again later, or use WhatsApp or email.',
  },
};
