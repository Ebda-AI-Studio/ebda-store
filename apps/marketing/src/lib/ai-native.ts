import type { CapabilityId } from './capability-registry';
import type { Locale } from './site';

/**
 * The "AI-native" story: what Ebda's AI does for a merchant, one block per area, each line a merchant
 * outcome. No provider or technology names (gate: tests/unit/marketing-no-tech-names.test.ts). Every line
 * is backed by code on main (evidence in .superpowers/marketing-report.md); a line with `needs` follows
 * that capability's status in capability-registry.ts and shows "coming soon" until it is live.
 */
export interface AiLine {
  text: string;
  needs?: CapabilityId;
  /** Plans that have it, when not every paid plan. */
  plan?: string;
}

export interface AiBlock {
  id: 'content' | 'search' | 'accounting' | 'inventory' | 'analytics' | 'operations';
  t: string;
  lines: AiLine[];
}

export interface AiNativeCopy {
  title: string;
  lead: string;
  planLabel: string;
  blocks: AiBlock[];
}

export const AI_NATIVE: Record<Locale, AiNativeCopy> = {
  ar: {
    title: 'ذكاء اصطناعي جوه كل حاجة، مش زرار على الجنب.',
    lead: 'ابدأ ستور بيشتغل جنبك في المتجر والبحث والحسابات والمخزون والأرقام. إنت اللي بتقرر، والذكاء الاصطناعي بيجهّز لك الشغل.',
    planLabel: 'متاح في',
    blocks: [
      {
        id: 'content',
        t: 'متجرك بيتكتب معاك',
        lines: [
          { text: 'اضغط زرار ويكتبلك وصف المنتج بالعربي والإنجليزي، وإنت بتراجع وتنشر.' },
          { text: 'ترجمة المنتجات بين العربي والإنجليزي بضغطة.' },
          {
            text: 'عناوين وأوصاف لمحركات البحث، وأسئلة شائعة، وتصنيفات ووسوم، ونص بديل للصور، لمنتج واحد أو لمتجرك كله.',
          },
        ],
      },
      {
        id: 'search',
        t: 'بحث بيفهم عملاءك',
        lines: [
          { text: 'كل منتج بياخد لوحده كلمات بحث بالمصري والفرانكو والإنجليزي، وتقدر تعدّلها.' },
          { text: 'العميل يكتب "gazma" أو "كوتشي" ولسه يلاقي المنتج.' },
          { text: 'بحث بالمعنى: العميل يكتب اللي في دماغه والبحث يفهم قصده.', needs: 'meaning' },
        ],
      },
      {
        id: 'accounting',
        t: 'حساباتك بتخلص أسرع',
        lines: [
          {
            text: 'صوّر إيصال المورّد وارفعه، فيتحوّل لمصروف مسودة جاهز تراجعه.',
            plan: 'باقتا النمو والأعمال',
          },
          {
            text: 'تنبيه لما هامش الربح ينزل أو التكاليف تقفز أو الإيرادات تقع أو المرتجعات تزيد، مع شرح بالعربي والإنجليزي.',
          },
        ],
      },
      {
        id: 'inventory',
        t: 'مخزونك بيقولك تعمل إيه',
        lines: [
          {
            text: 'اقتراحات إعادة الطلب: بيحسب سرعة بيع كل منتج وبيقولك إمتى تطلب وكام، ومعاه السبب.',
          },
          { text: 'المنتجات الراكدة بتتعلّم لوحدها، ومعاها نص جاهز لعرض تصفية.' },
          { text: 'إيميل ينبهك لما منتج يقرب يخلص.', plan: 'باقتا النمو والأعمال' },
        ],
      },
      {
        id: 'analytics',
        t: 'أرقامك بتتشرح',
        lines: [
          { text: 'سطرين بالعربي والإنجليزي فوق لوحة الأرقام بيشرحوا إيه اللي اتغيّر.' },
          { text: 'شوف عملاءك بحثوا عن إيه، وإيه اللي مالقوش له نتيجة.' },
          { text: 'المنتجات اللي بتتباع مع بعض بتظهر للعميل في صفحة المنتج والسلة.' },
        ],
      },
      {
        id: 'operations',
        t: 'مساعدك الذكي يشغّل المتجر',
        lines: [
          {
            text: 'اطلب من مساعدك يضيف منتجات ويعدّل أسعار ويراجع الطلبات بدل ما تفتح لوحة التحكم.',
            plan: 'باقتا النمو والأعمال',
          },
          { text: 'إيصال إنستا باي اللي العميل بيرفعه بيتقرا لوحده بدل ما حد يكتب بياناته.' },
          { text: 'متجرك بيظهر لمساعدات الذكاء الاصطناعي: ملف llms وفيد منتجات بيقروه.' },
        ],
      },
    ],
  },
  en: {
    title: 'AI inside everything, not a button on the side.',
    lead: 'Ebda Store works alongside you in your store, search, accounts, stock and numbers. You decide, and the AI prepares the work.',
    planLabel: 'Available on',
    blocks: [
      {
        id: 'content',
        t: 'Your store gets written with you',
        lines: [
          {
            text: 'Press a button and it writes the product description in Arabic and English, and you review and publish.',
          },
          { text: 'Translate products between Arabic and English in one click.' },
          {
            text: 'Search-engine titles and descriptions, FAQs, categories, tags and image alt text, for one product or your whole store.',
          },
        ],
      },
      {
        id: 'search',
        t: 'Search that understands your shoppers',
        lines: [
          {
            text: 'Every product gets its own search words in Egyptian Arabic, Franco and English, and you can edit them.',
          },
          { text: 'A shopper types "gazma" or "كوتشي" and still finds the product.' },
          {
            text: 'Search by meaning: shoppers type what they have in mind and search understands what they mean.',
            needs: 'meaning',
          },
        ],
      },
      {
        id: 'accounting',
        t: 'Your books close faster',
        lines: [
          {
            text: 'Snap a photo of a supplier receipt and upload it, and it becomes a draft expense for you to review.',
            plan: 'Growth and Business plans',
          },
          {
            text: 'Alerts when your margin drops, costs jump, revenue falls or refunds rise, explained in Arabic and English.',
          },
        ],
      },
      {
        id: 'inventory',
        t: 'Your stock tells you what to do',
        lines: [
          {
            text: 'Reorder suggestions: it works out how fast each product sells and tells you when to reorder and how much, with the reason.',
          },
          {
            text: 'Slow-moving products are flagged on their own, with ready-made clearance copy.',
          },
          {
            text: 'An email warns you when a product is about to run out.',
            plan: 'Growth and Business plans',
          },
        ],
      },
      {
        id: 'analytics',
        t: 'Your numbers explain themselves',
        lines: [
          { text: 'Two lines in Arabic and English above your numbers explain what changed.' },
          { text: 'See what shoppers searched for, and what they searched for and found nothing.' },
          {
            text: 'Products that sell together show up for shoppers on the product page and in the cart.',
          },
        ],
      },
      {
        id: 'operations',
        t: 'Your AI assistant runs the store',
        lines: [
          {
            text: 'Ask your assistant to add products, change prices and review orders instead of opening the dashboard.',
            plan: 'Growth and Business plans',
          },
          {
            text: 'The InstaPay receipt a customer uploads is read automatically, so nobody types the transfer details.',
          },
          {
            text: 'Your store shows up for AI assistants: an llms file and a product feed they can read.',
          },
        ],
      },
    ],
  },
};
