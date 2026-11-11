import type { Locale } from './site';

/**
 * The /support page (audit M-033). Ahmad's answer, 2026-11-11: support is 24/7. The Ebda AI Studio assistant answers first, a
 * person is the backup. Deliberately NO response-time figure: none is measured, so none is promised.
 */
export const SUPPORT_PAGE: Record<
  Locale,
  {
    title: string;
    desc: string;
    intro: string;
    hoursH: string;
    hoursP: string;
    flowH: string;
    flow: string[];
    escalateH: string;
    escalateLead: string;
    escalate: string[];
    reachH: string;
    reachP: string;
    reachCta: string;
  }
> = {
  ar: {
    title: 'الدعم',
    desc: 'الدعم شغال 24 ساعة في اليوم، 7 أيام في الأسبوع: مساعد ابدأ ستوديو للذكاء الاصطناعي بيرد أول، وأي موضوع معقد أو فيه فلوس بيروح لإنسان من الفريق.',
    intro: 'لو عندك سؤال أو مشكلة في ابدأ ستور أو ابدأ شات، دي طريقة الدعم عندنا.',
    hoursH: 'مواعيد الدعم',
    hoursP:
      'الدعم شغال 24 ساعة في اليوم، 7 أيام في الأسبوع، بما فيها الجُمَع والأعياد. مساعد ابدأ ستوديو للذكاء الاصطناعي هو أول واحد بيرد عليك، في أي وقت.',
    flowH: 'إزاي بنتعامل مع رسالتك',
    flow: [
      'تبعت رسالتك على الإيميل أو من صفحة التواصل.',
      'المساعد بيرد عليك ويحاول يحل الموضوع بنفس الرد.',
      'لو مش متأكد من الحل، أو الموضوع محتاج قرار من إنسان، بيحوّله لشخص من الفريق.',
    ],
    escalateH: 'إمتى بيروح لإنسان',
    escalateLead: 'المواضيع دي بيراجعها شخص من الفريق، مش المساعد لوحده:',
    escalate: [
      'أي موضوع فيه فلوس: دفع، استرداد، خصم متكرر أو خصم غلط.',
      'دخول الحساب والأمان: حساب مقفول، أو شك إن حد دخل على حسابك.',
      'مشكلة تقنية معقدة، أو حاجة المساعد ما قدرش يحلها.',
      'أي شكوى عايز تتراجع عند إنسان.',
    ],
    reachH: 'كلّمنا',
    reachP:
      'ابعت لنا على الإيميل أو من صفحة التواصل. اكتب اسم متجرك والمشكلة بالتفصيل، وصورة للشاشة لو متاحة.',
    reachCta: 'صفحة التواصل',
  },
  en: {
    title: 'Support',
    desc: 'Support runs 24 hours a day, 7 days a week: the Ebda AI Studio assistant replies first, and anything complex or involving money goes to a person on the team.',
    intro:
      'If you have a question or a problem with Ebda Store or Ebda Chat, this is how support works.',
    hoursH: 'Support hours',
    hoursP:
      'Support runs 24 hours a day, 7 days a week, including Fridays and holidays. The Ebda AI Studio AI assistant is the first to reply, at any hour.',
    flowH: 'How we handle your message',
    flow: [
      'You send your message by email or from the contact page.',
      'The assistant replies and tries to solve it in that same reply.',
      'If it is not sure of the fix, or the matter needs a human decision, it hands it to a person on the team.',
    ],
    escalateH: 'When it goes to a person',
    escalateLead: 'A person on the team reviews these, not the assistant alone:',
    escalate: [
      'Anything involving money: a payment, a refund, a repeated or wrong charge.',
      'Account access and security: a locked account, or a suspicion that someone got into your account.',
      'A complex technical problem, or anything the assistant could not solve.',
      'Any complaint you want a human to look at again.',
    ],
    reachH: 'Contact us',
    reachP:
      'Email us or use the contact page. Include your store name and the problem in detail, with a screenshot if you have one.',
    reachCta: 'Contact page',
  },
};
