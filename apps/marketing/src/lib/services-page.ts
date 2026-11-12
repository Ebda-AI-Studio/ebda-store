import { SERVICE_LINE_CONTENT, type LineId } from './service-lines-content';
import type { Locale } from './site';

/** Interface copy of the Services index and the line pages (the lines' own copy is in service-lines-content.ts). Wording approved by Ahmad 2026-11-10 (SERVICES-IA-1, SERVICES-COPY-APPROVED-1). */
export const SERVICES_PAGE = {
  ar: {
    nav: 'الخدمات',
    meta: {
      title: 'الخدمات',
      desc: 'ذكاء اصطناعي وبرمجيات واستشارات من ابدأ ستوديو للذكاء الاصطناعي، وخدمات فريقنا بينفذها على الأرض: تسويق وتصميم وتنفيذ البيوت وتنظيم فعاليات.',
    },
    eyebrow: 'الخدمات',
    h1: 'قولنا محتاج إيه، وفريقنا بينفذه',
    lead: 'ابدأ ستوديو للذكاء الاصطناعي فريق بيشتغل معاك. بنقدم خدمات الذكاء الاصطناعي والبرمجيات والاستشارات، وكمان خدمات بننفذها بنفسنا على الأرض: فعاليات وتسويق وتصميم وتنفيذ البيوت. البرامج اللي بنبنيها منتجات منفصلة، وليها مكانها.',
    coreH: 'الذكاء الاصطناعي والبرمجيات',
    coreLead: 'خدمات الأساس عندنا: فريقنا يبني ويشغّل ويدرّب.',
    linesH: 'خدمات على الأرض',
    linesLead:
      'فريق بيجيلك، ويخطط وينفذ ويتابع معاك من أول مكالمة. كل خدمة لها صفحة، وتقدر تتواصل معنا منها مباشرة.',
    cardCta: 'شوف الخدمة',
    contactCta: 'احكيلنا عن شغلك',
    /** The header's own CTA on a service page: short, so it fits the bar and the Menu's pinned pair (Ruling NAV-CTA-2). */
    headerCta: 'كلّمنا',
  },
  en: {
    nav: 'Services',
    meta: {
      title: 'Services',
      desc: 'AI, software and consulting from Ebda AI Studio, plus services our team delivers on the ground: marketing, home design and build, and events.',
    },
    eyebrow: 'Services',
    h1: 'Tell us what you need, and our team does it',
    lead: 'Ebda AI Studio is a team that works with you. We deliver AI, software and consulting, and services we carry out ourselves on the ground: events, marketing, and home design and build. The software we build is a separate set of products, with its own place.',
    coreH: 'AI and software',
    coreLead: 'Our core services: our team builds, runs and trains.',
    linesH: 'Services on the ground',
    linesLead:
      'A team that comes to you and plans, delivers and follows up from the first call. Each service has a page, and you can contact us from it.',
    cardCta: 'See the service',
    contactCta: 'Tell us about your work',
    headerCta: 'Talk to us',
  },
} as const;

/** Section labels on a line page, one shared set (the three lines read alike). */
export const LINE_UI = {
  ar: {
    back: 'كل الخدمات',
    whatH: 'بنعمل إيه',
    pathH: undefined,
    howH: 'بنشتغل إزاي',
    whyH: 'ليه إحنا',
    faqH: 'أسئلة شائعة',
    faqLead: 'إجابات قصيرة على الأسئلة اللي بتتسأل كتير. لو سؤالك مش هنا، ابعتهولنا.',
    contactH: 'تواصل معنا',
    nextH: 'بعد ما تبعت',
    illustrative: 'صورة توضيحية',
    contactCta: 'ابعتلنا رسالة',
    emailLead: 'أو راسلنا على',
    eyebrow: 'خدمة من ابدأ ستوديو للذكاء الاصطناعي',
  },
  en: {
    back: 'All services',
    whatH: 'What we do',
    pathH: undefined,
    howH: 'How we work',
    whyH: 'Why us',
    faqH: 'Frequently asked questions',
    faqLead: 'Short answers to the questions we hear most. If yours is not here, send it to us.',
    contactH: 'Contact us',
    nextH: 'What happens next',
    illustrative: 'Illustrative image',
    contactCta: 'Send us a message',
    emailLead: 'Or write to',
    eyebrow: 'A service of Ebda AI Studio',
  },
} as const;

/** The short band on the studio home (published only): the on-the-ground services, linking to Services. */
export const HOME_SERVICES = {
  ar: {
    h: 'وبننفذ كمان على الأرض',
    p: 'فعاليات وتسويق وتصميم وتنفيذ البيوت: فريق بيشتغل معاك من أول مكالمة لحد التسليم.',
    cta: 'شوف الخدمات',
  },
  en: {
    h: 'We also deliver on the ground',
    p: 'Events, marketing, and home design and build: a team that works with you from the first call to handover.',
    cta: 'See our services',
  },
} as const;

export const lineMeta = (id: LineId, locale: Locale) => {
  const c = SERVICE_LINE_CONTENT[id][locale];
  return { title: c.hero.h1, tagline: c.tagline };
};
