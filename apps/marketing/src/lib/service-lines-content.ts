/**
 * The copy of the three SERVICE LINES (Marketing, Design, Events; Ruling SERVICES-IA-1), condensed from the rebuilt sub-brand sites
 * (Ebda-AI-Studio/ebda-sites PR #2). One entry per line, Arabic (Egyptian) first, then English, same shape. NO prices, clients, numbers
 * or testimonials are claimed. The service lists, the benefits and the Events scope are confirmed by Ahmad (2026-11-09); the rest of the
 * wording (FAQ, process steps, lists, next steps, closing and hero lines) is APPROVED by Ahmad (2026-11-10, Ruling SERVICES-COPY-APPROVED-1)
 * and live in production (repo variable EBDA_SERVICE_LINES=on; lib/service-lines.ts). All images are generated and captioned "illustrative".
 */
export type LineId = 'marketing' | 'design' | 'events';
export type Td = { t: string; d: string };
export type LineCopy = {
  tagline: string;
  alt: { hero: string; a: string; b: string };
  hero: { h1: string; lead: string; cta: string };
  what: {
    statement: string;
    groups: { id: string; title: string; intro: string; items: Td[] }[];
  };
  how: { statement: string; steps: Td[]; getLabel: string; get: string[] };
  path: { label: string; statement: string; items: Td[] };
  why: {
    statement: string;
    edgeLabel: string;
    points: Td[];
    notLabel: string;
    not: string[];
  };
  faq: { q: string; a: string }[];
  next: Td[];
  closer: { h: string; p: string };
};
export type LineContent = {
  id: LineId;
  images: { hero: string; a: string; b: string };
  ar: LineCopy;
  en: LineCopy;
};

export const SERVICE_LINE_CONTENT: Record<LineId, LineContent> = {
  marketing: {
    id: 'marketing',
    images: {
      hero: 'marketing-hero',
      a: 'marketing-podcast',
      b: 'marketing-print',
    },
    ar: {
      tagline: 'تسويق وإعلان وإنتاج محتوى',
      alt: {
        hero: 'ستوديو تصوير صغير: كاميرا على حامل قدام ترابيزة عليها فناجين فخار وصينية نحاس، وإضاءة سوفت بوكس.',
        a: 'ركن تسجيل بودكاست فيه ميكروفونين على مكتب خشب وسماعات ولمبة نحاس منورة.',
        b: 'بوسترات وفلايرات مطبوعة بأشكال هندسية دهبي وعاجي متفرشة على ترابيزة رخام.',
      },
      hero: {
        h1: 'محتوى وإعلانات بتجيبلك عملاء، وأرقام بتقولك إيه اللي نفع',
        lead: 'إحنا فريق تسويق وإنتاج من ابدأ ستوديو للذكاء الاصطناعي. بنخطط معاك، وبنصوّر ونكتب ونصمم، وبنشغّل إعلاناتك، وبنرد على كل عميل بيسأل على واتساب.',
        cta: 'احكيلنا عن مشروعك',
      },
      what: {
        statement:
          'أربع حاجات بنمسكها معاك من أولها لآخرها، عشان التسويق يبقى شغل واحد مترابط مش حتت متفرقة.',
        groups: [
          {
            id: 'strategy',
            title: 'الاستراتيجية',
            intro: 'قبل ما نصرف جنيه على إعلان، بنعرف إنت رايح فين ومين اللي هيشتري منك.',
            items: [
              {
                t: 'خطط واستراتيجيات التسويق',
                d: 'خطة مكتوبة فيها الهدف والجمهور والقنوات والميزانية، ورقم واضح نقيس بيه النتيجة.',
              },
              {
                t: 'تحليل SWOT',
                d: 'بنحط نقط قوتك وضعفك والفرص والمخاطر قدامك، عشان تعرف تبدأ منين.',
              },
              {
                t: 'شخصيات العملاء',
                d: 'بنرسم صورة واضحة لعميلك: بيدوّر على إيه، وبيقلق من إيه، وبيقرر إزاي.',
              },
            ],
          },
          {
            id: 'content',
            title: 'المحتوى والإنتاج',
            intro:
              'فريق واحد بيكتب ويصوّر ويصمم ويعمل مونتاج، فكل اللي بينزل باسمك شكله وصوته واحد.',
            items: [
              {
                t: 'صناعة المحتوى',
                d: 'أفكار وكتابة وجدول نشر لكل منصة، ومحتوى جاهز ينزل في ميعاده.',
              },
              {
                t: 'التصوير الفوتوغرافي',
                d: 'صور منتجات وأماكن وفريق شغل، بإضاءة وكادر مدروسين.',
              },
              {
                t: 'التصوير بالفيديو',
                d: 'إعلانات قصيرة وتغطيات وفيديوهات للسوشيال، بفريق ومعدات على قد المشروع.',
              },
              {
                t: 'التصميم الجرافيكي',
                d: 'بوستات وهوية بصرية وعروض تقديمية بشكل متناسق يشبه شركتك.',
              },
              {
                t: 'الفلايرز والمطبوعات',
                d: 'فلايرات وبروشورات جاهزة للطباعة أو للنشر أونلاين.',
              },
              {
                t: 'المونتاج',
                d: 'تقطيع وإيقاع وتلوين وترجمة على الشاشة، لحد ما الفيديو يبقى جاهز للنشر.',
              },
              {
                t: 'هندسة ومونتاج الصوت',
                d: 'تنضيف الصوت وضبط مستواه وموسيقى وتعليق صوتي لأي فيديو أو بودكاست.',
              },
              {
                t: 'البودكاست',
                d: 'من فكرة البرنامج والضيوف للتسجيل والمونتاج والنشر.',
              },
            ],
          },
          {
            id: 'ads',
            title: 'الإعلانات وشراء الميديا',
            intro:
              'بنحط فلوس الإعلان في المكان اللي بيجيب نتيجة، وبنوريك الأرقام من غير لف ودوران.',
            items: [
              {
                t: 'إعلانات رقمية',
                d: 'حملات على السوشيال ميديا ومحركات البحث، بأكتر من نسخة للإعلان عشان نعرف أنهي فيهم أحسن.',
              },
              {
                t: 'إعلانات مطبوعة',
                d: 'إعلانات للجرايد والمجلات واللافتات بنفس روح حملتك الرقمية.',
              },
              {
                t: 'شراء الميديا',
                d: 'بنحجز المساحات الإعلانية ونتابعها يوم بيوم، وننقل الميزانية للي شغال.',
              },
              {
                t: 'تقارير واضحة',
                d: 'تقرير بسيط بالأرقام المهمة بس: صرفت كام، وجالك كام عميل، والعميل كلفك كام.',
              },
            ],
          },
          {
            id: 'conversations',
            title: 'محادثات العملاء',
            intro: 'الإعلان بيجيب الرسالة، وإحنا بنضمن إن كل رسالة يتردّ عليها.',
            items: [
              {
                t: 'رد على كل عميل على واتساب',
                d: 'من خلال ابدأ شات، كل عميل محتمل بيسأل بيلاقي رد، حتى بالليل وفي الإجازات.',
              },
              {
                t: 'أتمتة التسويق',
                d: 'رسايل متابعة وتذكير بتتبعت لوحدها في الوقت المناسب، فمحدش بيتنسي.',
              },
              {
                t: 'ربط الإعلان بالمحادثة',
                d: 'بنعرف كل محادثة جت من أنهي إعلان، فتعرف الإعلان اللي بيجيب بيع فعلًا.',
              },
            ],
          },
        ],
      },
      how: {
        statement: 'بنبدأ بهدف واضح ورقم نقيس بيه، وبعدين ننتج وننشر، وكل أسبوع نشوف الأرقام سوا.',
        steps: [
          {
            t: 'بنسمعك ونفهم هدفك',
            d: 'بنقعد معاك ونفهم شغلك وعميلك، ونتفق على هدف واحد واضح ورقم نقيس بيه.',
          },
          {
            t: 'نكتب الخطة',
            d: 'بنرجعلك بخطة فيها القنوات والمحتوى والميزانية والجدول، وتعدّل عليها لحد ما تبقى مرتاح لها.',
          },
          {
            t: 'ننتج المحتوى',
            d: 'بنكتب ونصوّر ونصمم ونعمل المونتاج، وبنبعتلك كل حاجة توافق عليها قبل ما تنزل.',
          },
          {
            t: 'نطلق الحملات',
            d: 'بننشر ونشغّل الإعلانات، وكل رسالة بتيجي بيتردّ عليها على واتساب.',
          },
          {
            t: 'نقيس ونعدّل',
            d: 'كل أسبوع بنشوف الأرقام سوا، نكمّل على اللي نفع ونوقف اللي ما نفعش.',
          },
        ],
        getLabel: 'هتاخد إيه',
        get: [
          'خطة مكتوبة بهدف ورقم واضح',
          'جدول نشر تعرف منه إيه اللي نازل وإمتى',
          'محتوى بتوافق عليه قبل ما ينزل',
          'تقرير أسبوعي بالأرقام المهمة بس',
          'كل رسالة من عميل يتردّ عليها',
          'شخص واحد مسؤول عن مشروعك تكلمه في أي وقت',
        ],
      },
      path: {
        label: 'من الإعلان للبيع',
        statement: 'كل عميل بيمشي في طريق واحد واضح، وإحنا ماسكين كل محطة فيه.',
        items: [
          {
            t: 'الإعلان',
            d: 'إعلان متصمم لعميلك بالظبط، على المنصة اللي هو موجود عليها.',
          },
          {
            t: 'المحادثة',
            d: 'العميل بيسأل على واتساب وبيلاقي رد على طول.',
          },
          {
            t: 'المتابعة',
            d: 'رسايل متابعة بتتبعت لوحدها لحد ما يقرر.',
          },
          {
            t: 'البيع',
            d: 'بنحوّلك العميل الجاهز يشتري، أو اللي محتاجك شخصيًا.',
          },
          {
            t: 'التقرير',
            d: 'بتعرف الإعلان ده جاب كام محادثة وكام بيع.',
          },
        ],
      },
      why: {
        statement:
          'الذكاء الاصطناعي والبرامج عندنا جزء من الشغل نفسه، فإنت بتاخد إنتاج أسرع وأرقام أوضح.',
        edgeLabel: 'اللي بيفرق',
        points: [
          {
            t: 'إنتاج أسرع',
            d: 'أدوات الذكاء الاصطناعي بتسرّع الأفكار والكتابة والمونتاج، فبتاخد محتوى أكتر في وقت أقل، والجودة بيراجعها فريقنا بنفسه.',
          },
          {
            t: 'أرقام واضحة',
            d: 'بنربط الإعلانات والمحادثات والمبيعات ببعض، فتعرف كل جنيه راح فين وجاب إيه.',
          },
          {
            t: 'ولا رسالة بتضيع',
            d: 'العملاء اللي بيسألوا على واتساب بيلاقوا رد على طول، والمتابعة بتحصل لوحدها.',
          },
          {
            t: 'فريق واحد',
            d: 'الخطة والمحتوى والإعلان والمحادثات عند فريق واحد، فمفيش تضارب ولا لف بين شركات.',
          },
          {
            t: 'بنقولك الحقيقة',
            d: 'لو حاجة مش نافعة بنقولك ونوقفها، بدل ما نكمّل نصرف فيها.',
          },
        ],
        notLabel: 'اللي مش هنعمله',
        not: [
          'مش هنوعدك بأرقام مش هنقدر نقيسها',
          'مش هنشتري متابعين أو تفاعل وهمي',
          'مش هننشر حاجة باسمك من غير موافقتك',
          'مش هنخبّي عنك الأرقام اللي مش عاجباك',
        ],
      },
      faq: [
        {
          q: 'ممكن آخد خدمة واحدة بس؟',
          a: 'أكيد. ممكن تاخد تصوير بس، أو إعلانات بس، أو نمسكلك التسويق كله. بنقترح عليك اللي يناسب هدفك وميزانيتك.',
        },
        {
          q: 'التكلفة بتبقى كام؟',
          a: 'التكلفة بتختلف حسب الخدمات وحجم الشغل. بعد أول مكالمة بنبعتلك عرض سعر مكتوب بالجنيه المصري، ومفيش أي تكلفة إلا بعد ما توافق.',
        },
        {
          q: 'ميزانية الإعلانات داخلة في السعر؟',
          a: 'لأ. ميزانية الإعلانات بتتدفع للمنصات الإعلانية، وأتعابنا منفصلة عنها، وده بيبقى مكتوب بوضوح في العرض.',
        },
        {
          q: 'إمتى هشوف نتيجة؟',
          a: 'أول محتوى بيبقى جاهز بعد ما نتفق على الخطة. أما النتيجة في المبيعات فبتحتاج وقت تختلف مدته حسب السوق، وبنوريك الأرقام كل أسبوع من أول يوم.',
        },
        {
          q: 'الذكاء الاصطناعي هو اللي بيعمل المحتوى؟',
          a: 'الذكاء الاصطناعي بيساعدنا نسرّع الأفكار والمسودات والمونتاج، لكن الكتابة النهائية والتصوير والمراجعة بيعملهم فريقنا. ومفيش حاجة بتنزل من غير ما إنت توافق عليها.',
        },
        {
          q: 'الرد على واتساب بيشتغل إزاي؟',
          a: 'بنستخدم ابدأ شات عشان نرد على الرسايل اللي بتيجي من إعلاناتك، ونحوّل لك أي عميل جاهز يشتري أو محتاج رد منك شخصيًا.',
        },
        {
          q: 'بتشتغلوا مع شركات بره القاهرة؟',
          a: 'أيوة. التخطيط والمتابعة بيحصلوا أونلاين، والتصوير بنتفق على مكانه وميعاده.',
        },
      ],
      next: [
        {
          t: 'بنقرا رسالتك',
          d: 'حد من الفريق بيقرا رسالتك بنفسه ويرد عليك.',
        },
        {
          t: 'مكالمة قصيرة',
          d: 'بنتكلم مع بعض عشان نفهم هدفك وجمهورك.',
        },
        {
          t: 'عرض مكتوب',
          d: 'بنبعتلك خطة وعرض سعر بالجنيه المصري تراجعهم براحتك.',
        },
      ],
      closer: {
        h: 'جاهز تبدأ؟',
        p: 'ابعتلنا سطرين عن شغلك وهدفك، وهنرجعلك باقتراح واضح للخطوة الجاية.',
      },
    },
    en: {
      tagline: 'Marketing, advertising and content production',
      alt: {
        hero: 'A small photo studio: a camera on a tripod facing a table with ceramic cups on a brass tray, lit by a softbox.',
        a: 'A podcast recording corner with two microphones on a wooden desk, headphones and a glowing brass lamp.',
        b: 'Printed posters and flyers with gold and ivory geometric shapes laid out on a stone table.',
      },
      hero: {
        h1: 'Content and ads that bring you customers, and numbers that show what worked',
        lead: 'We are the marketing and production team of Ebda AI Studio. We plan with you, shoot, write and design, run your ads, and answer every customer who asks on WhatsApp.',
        cta: 'Tell us about your project',
      },
      what: {
        statement:
          'Four things we run with you end to end, so your marketing works as one connected effort, not scattered pieces.',
        groups: [
          {
            id: 'strategy',
            title: 'Strategy',
            intro:
              'Before a pound goes into an ad, we know where you are heading and who will buy from you.',
            items: [
              {
                t: 'Marketing plans and strategies',
                d: 'A written plan with the goal, audience, channels and budget, and a clear number to measure the result.',
              },
              {
                t: 'SWOT analysis',
                d: 'Your strengths, weaknesses, opportunities and threats laid out, so you know where to start.',
              },
              {
                t: 'Customer personas',
                d: 'A clear picture of your customer: what they look for, what worries them and how they decide.',
              },
            ],
          },
          {
            id: 'content',
            title: 'Content and production',
            intro:
              'One team writes, shoots, designs and edits, so everything published in your name looks and sounds the same.',
            items: [
              {
                t: 'Content creation',
                d: 'Ideas, writing and a posting calendar for each platform, with content ready on time.',
              },
              {
                t: 'Photography',
                d: 'Product, place and team photography with considered light and framing.',
              },
              {
                t: 'Videography',
                d: 'Short ads, event coverage and social videos, with a crew and kit sized to the project.',
              },
              {
                t: 'Graphic design',
                d: 'Posts, visual identity and presentations that look consistent and look like you.',
              },
              {
                t: 'Flyers and print',
                d: 'Flyers and brochures ready for print or for sharing online.',
              },
              {
                t: 'Video editing',
                d: 'Cutting, pacing, colour and on-screen captions until the video is ready to publish.',
              },
              {
                t: 'Sound editing',
                d: 'Clean, balanced audio, music and voice-over for any video or podcast.',
              },
              {
                t: 'Podcasts',
                d: 'From the show idea and guests to recording, editing and publishing.',
              },
            ],
          },
          {
            id: 'ads',
            title: 'Advertising and media buying',
            intro: 'We put ad money where it brings results, and show you the numbers plainly.',
            items: [
              {
                t: 'Digital ads',
                d: 'Social and search campaigns, with several versions of each ad so we learn which one works.',
              },
              {
                t: 'Printed ads',
                d: 'Newspaper, magazine and signage ads that carry the same idea as your digital campaign.',
              },
              {
                t: 'Media buying',
                d: 'We book the ad space, follow it day by day and move budget to what performs.',
              },
              {
                t: 'Clear reports',
                d: 'A short report with only the numbers that matter: what you spent, how many customers came and what each one cost.',
              },
            ],
          },
          {
            id: 'conversations',
            title: 'Customer conversations',
            intro: 'Ads bring the messages; we make sure every one of them gets an answer.',
            items: [
              {
                t: 'Every lead answered on WhatsApp',
                d: 'Through Ebda Chat, every potential customer who asks gets a reply, including at night and on holidays.',
              },
              {
                t: 'Marketing automation',
                d: 'Follow-ups and reminders sent on their own at the right moment, so no one is forgotten.',
              },
              {
                t: 'Ads linked to conversations',
                d: 'We know which ad each conversation came from, so you can see which ads actually sell.',
              },
            ],
          },
        ],
      },
      how: {
        statement:
          'We start with a clear goal and a number to measure it by, then produce and publish, and review the numbers with you every week.',
        steps: [
          {
            t: 'We listen and agree the goal',
            d: 'We learn your business and your customer, and agree one clear goal and a number to measure it by.',
          },
          {
            t: 'We write the plan',
            d: 'You get a plan with channels, content, budget and schedule, and adjust it until you are happy with it.',
          },
          {
            t: 'We produce the content',
            d: 'We write, shoot, design and edit, and send you everything to approve before it goes out.',
          },
          {
            t: 'We launch the campaigns',
            d: 'We publish and run the ads, and every message that comes in is answered on WhatsApp.',
          },
          {
            t: 'We measure and adjust',
            d: 'Every week we look at the numbers together, keep what worked and stop what did not.',
          },
        ],
        getLabel: 'What you get',
        get: [
          'A written plan with a clear goal and number',
          'A posting calendar that shows what goes out and when',
          'Content you approve before it is published',
          'A weekly report with only the numbers that matter',
          'An answer for every customer message',
          'One person responsible for your project, reachable any time',
        ],
      },
      path: {
        label: 'From ad to sale',
        statement: 'Every customer follows one clear path, and we look after every stop on it.',
        items: [
          {
            t: 'The ad',
            d: 'An ad made for your exact customer, on the platform where they are.',
          },
          {
            t: 'The conversation',
            d: 'The customer asks on WhatsApp and gets an answer straight away.',
          },
          {
            t: 'The follow-up',
            d: 'Follow-up messages go out on their own until they decide.',
          },
          {
            t: 'The sale',
            d: 'We hand you the customer who is ready to buy, or who needs you personally.',
          },
          {
            t: 'The report',
            d: 'You see how many conversations and sales that ad brought.',
          },
        ],
      },
      why: {
        statement:
          'AI and software are part of how we work, so you get faster production and clearer numbers.',
        edgeLabel: 'What is different',
        points: [
          {
            t: 'Faster production',
            d: 'AI tools speed up ideas, writing and editing, so you get more content in less time, and our team checks the quality itself.',
          },
          {
            t: 'Clear numbers',
            d: 'We connect ads, conversations and sales, so you can see where every pound went and what it brought back.',
          },
          {
            t: 'No message lost',
            d: 'Customers who ask on WhatsApp get an answer straight away, and follow-ups happen on their own.',
          },
          {
            t: 'One team',
            d: 'Plan, content, ads and conversations sit with one team, so nothing contradicts and nothing falls between agencies.',
          },
          {
            t: 'We tell you the truth',
            d: 'If something is not working we say so and stop it, rather than keep spending on it.',
          },
        ],
        notLabel: 'What we will not do',
        not: [
          'Promise numbers we cannot measure',
          'Buy followers or fake engagement',
          'Publish anything in your name without your approval',
          'Hide the numbers you do not like',
        ],
      },
      faq: [
        {
          q: 'Can I take just one service?',
          a: 'Yes. You can take photography only, ads only, or have us run all your marketing. We suggest what fits your goal and budget.',
        },
        {
          q: 'How much does it cost?',
          a: 'It depends on the services and the amount of work. After the first call we send a written quote in Egyptian pounds, and nothing is charged until you agree.',
        },
        {
          q: 'Is the ad budget included in your price?',
          a: 'No. The ad budget is paid to the ad platforms and our fee is separate. The quote states both clearly.',
        },
        {
          q: 'When will I see results?',
          a: 'The first content is ready once we agree the plan. Sales results take a time that depends on your market, and we show you the numbers every week from day one.',
        },
        {
          q: 'Does AI make the content?',
          a: 'AI helps us speed up ideas, drafts and editing, but the final writing, the shoots and the review are done by our team. Nothing is published without your approval.',
        },
        {
          q: 'How do WhatsApp replies work?',
          a: 'We use Ebda Chat to answer the messages your ads bring in, and hand you any customer who is ready to buy or needs you personally.',
        },
        {
          q: 'Do you work with businesses outside Cairo?',
          a: 'Yes. Planning and follow-up happen online, and we agree the place and date of any shoot with you.',
        },
      ],
      next: [
        {
          t: 'We read your message',
          d: 'A person on the team reads it and replies to you.',
        },
        {
          t: 'A short call',
          d: 'We talk to understand your goal and your audience.',
        },
        {
          t: 'A written proposal',
          d: 'You get a plan and a quote in Egyptian pounds to review in your own time.',
        },
      ],
      closer: {
        h: 'Ready to start?',
        p: 'Send us two lines about your business and your goal, and we will come back with a clear next step.',
      },
    },
  },
  design: {
    id: 'design',
    images: {
      hero: 'design-hero',
      a: 'design-kitchen',
      b: 'design-workshop',
    },
    ar: {
      tagline: 'تصميم داخلي وخارجي وتنفيذ البيت كله',
      alt: {
        hero: 'صالة شقة وقت المغرب فيها كنبة بيج وخشب لامع على الحيطان، ونور شباك بقوس واقع على الحيطة.',
        a: 'مطبخ متفصّل بدواليب خشب جوز تحت ودواليب عاجي فوق ومقابض نحاس رفيعة ورخامة فاتحة.',
        b: 'ترابيزة نجارة عليها ألواح خشب متقطعة ومترصّصة ومسطرة حديد وفارة وأزاميل.',
      },
      hero: {
        h1: 'بيتك من جوه ومن بره، تشوفه قبل ما يتنفذ',
        lead: 'إحنا فريق تصميم وتنفيذ من ابدأ ستوديو للذكاء الاصطناعي. بنصمم الداخلي والخارجي والديكور، وبننفذ الشقة أو البيت بالكامل: نجارة ومطابخ وكل الأثاث.',
        cta: 'احكيلنا عن مكانك',
      },
      what: {
        statement:
          'من أول فكرة لحد آخر مسمار، التصميم والتنفيذ عند فريق واحد، فاللي شفته على الشاشة هو اللي بيتبني.',
        groups: [
          {
            id: 'design',
            title: 'التصميم',
            intro: 'تصميم يناسب طريقة عيشتك وميزانيتك، مش صورة حلوة وخلاص.',
            items: [
              {
                t: 'التصميم الداخلي',
                d: 'توزيع المساحات والخامات والألوان والإضاءة لكل أوضة، على حسب استخدامك ليها.',
              },
              {
                t: 'التصميم الخارجي',
                d: 'واجهات وجناين وتراسات وبلكونات بتكمّل شكل البيت من بره.',
              },
              {
                t: 'تصميم الديكور',
                d: 'الأسقف والحيطان والأرضيات والإضاءة والتفاصيل اللي بتدّي المكان شخصيته.',
              },
              {
                t: 'تصميم ما قبل الديكور',
                d: 'نجهّز المساحة على البرامج قبل الديكور: التوزيع والكهربا والسباكة، عشان التنفيذ يمشي من غير مفاجآت.',
              },
            ],
          },
          {
            id: 'build',
            title: 'التنفيذ',
            intro: 'فريقنا بينفذ اللي اتصمم، ومهندس بيتابع الشغل في الموقع.',
            items: [
              {
                t: 'تنفيذ الشقة أو البيت بالكامل',
                d: 'من التشطيب الأساسي لحد التسليم والمفتاح في إيدك، بجدول واضح.',
              },
              {
                t: 'النجارة',
                d: 'أبواب ودواليب حيطة وتجليد خشب، متقاسة على مكانك بالظبط.',
              },
              {
                t: 'المطابخ',
                d: 'تصميم وتنفيذ مطبخ على مقاس مكانك وطريقة طبخك، من الدواليب للرخامة للإكسسوارات.',
              },
              {
                t: 'كل أنواع الأثاث',
                d: 'كنب وسراير وترابيزات ومكتبات متفصّلة على المقاس والتصميم اللي اتفقنا عليه.',
              },
            ],
          },
          {
            id: 'how',
            title: 'إزاي الخدمة بتشتغل',
            intro: 'دي حاجات بنعملها إحنا ليك جوه كل مشروع، مش أدوات محتاج تتعلمها.',
            items: [
              {
                t: 'صورة واقعية من صور مكانك',
                d: 'بتبعتلنا صور المكان زي ما هو، وبنرجعلك صور واقعية لشكله بعد التصميم.',
              },
              {
                t: 'تكلفة مبدئية بالجنيه بدري',
                d: 'من أول التصميم بتعرف تكلفة تقريبية بالجنيه المصري، فتقرر وإنت عارف.',
              },
              {
                t: 'متابعة وموافقات على واتساب',
                d: 'صور التقدم وكل قرار محتاج موافقتك بيوصلك على واتساب، وبترد من مكانك.',
              },
              {
                t: 'قوائم تقطيع دقيقة',
                d: 'مقاسات المطبخ والنجارة بتطلع من التصميم نفسه، فالقطع بيتقص صح من أول مرة.',
              },
              {
                t: 'فيديو جولة جوه المكان',
                d: 'بتتمشى جوه بيتك في فيديو قبل التنفيذ، وتشوف الإحساس بالمساحة والنور.',
              },
            ],
          },
        ],
      },
      how: {
        statement:
          'بنزور المكان وبنسمعك، وبنوريك التصميم صورة واقعية قبل التنفيذ، وبعدين ننفذ ونتابع معاك خطوة بخطوة.',
        steps: [
          {
            t: 'بنسمعك ونعاين المكان',
            d: 'بنفهم احتياجك وطريقة عيشتك وميزانيتك، وبنقيس المكان أو بنبدأ من صور بتبعتها.',
          },
          {
            t: 'تشوف الفكرة صورة واقعية',
            d: 'بنوريك شكل المكان بعد التصميم في صور واقعية وفيديو جولة، ومعاها تكلفة مبدئية بالجنيه.',
          },
          {
            t: 'نظبط التصميم سوا',
            d: 'بتعدّل لحد ما يعجبك، والتكلفة بتتحدّث مع كل تعديل فتفضل عارف إنت فين.',
          },
          {
            t: 'ننفذ ونتابع معاك',
            d: 'فريقنا بينفذ، وبتوصلك صور التقدم والقرارات اللي محتاجة موافقتك على واتساب.',
          },
          {
            t: 'نسلّمك المكان',
            d: 'بنسلّمك المكان زي ما شفته، وبنراجع معاك كل تفصيلة قبل الاستلام.',
          },
        ],
        getLabel: 'هتاخد إيه',
        get: [
          'صور واقعية لمكانك بعد التصميم',
          'فيديو جولة جوه المكان قبل التنفيذ',
          'تكلفة مبدئية بالجنيه من أول التصميم',
          'رسومات ومقاسات تنفيذ واضحة',
          'متابعة وموافقات على واتساب',
          'مهندس واحد مسؤول عن مشروعك',
        ],
      },
      path: {
        label: 'من صورة لبيت متبني',
        statement:
          'اللي بتشوفه في كل محطة هو اللي بيوصل للمحطة اللي بعدها، من غير ما حاجة تتوه في النص.',
        items: [
          {
            t: 'صورة مكانك',
            d: 'بتصوّر المكان زي ما هو وتبعتهولنا.',
          },
          {
            t: 'صورة بعد التصميم',
            d: 'بنرجعلك صور واقعية لشكله بعد التصميم.',
          },
          {
            t: 'التكلفة المبدئية',
            d: 'بتعرف تكلفة تقريبية بالجنيه وإنت لسه بتقرر.',
          },
          {
            t: 'فيديو الجولة',
            d: 'بتتمشى جوه المكان في فيديو قبل أول مسمار.',
          },
          {
            t: 'التنفيذ',
            d: 'مقاسات القطع طالعة من التصميم، والمتابعة على واتساب.',
          },
        ],
      },
      why: {
        statement:
          'البرامج والذكاء الاصطناعي عندنا بيخلّوك تشوف وتقرر بدري، فبتوفّر وقت وفلوس كانت هتضيع في التعديل بعد التنفيذ.',
        edgeLabel: 'اللي بيفرق',
        points: [
          {
            t: 'تشوف قبل ما تدفع في التنفيذ',
            d: 'الصور الواقعية وفيديو الجولة بيخلّوك تقرر وإنت شايف، مش بتتخيل من رسمة.',
          },
          {
            t: 'تعرف التكلفة بدري',
            d: 'تكلفة مبدئية بالجنيه من أول التصميم بتتحدّث مع كل تعديل، فمفيش رقم مفاجئ في الآخر.',
          },
          {
            t: 'قص صح من أول مرة',
            d: 'قوائم التقطيع بتطلع من التصميم نفسه، فالهدر أقل والتركيب أدق.',
          },
          {
            t: 'متابعة من غير مشاوير',
            d: 'صور التقدم والموافقات على واتساب، فتتابع بيتك وإنت في شغلك.',
          },
          {
            t: 'فريق واحد من الأول للآخر',
            d: 'اللي صمم هو اللي بينفذ، فمحدش بيرمي المسؤولية على حد.',
          },
        ],
        notLabel: 'اللي مش هنعمله',
        not: [
          'مش هنبدأ تنفيذ قبل ما توافق على التصميم والتكلفة',
          'مش هنغيّر خامة من غير ما نرجعلك',
          'مش هنوريك صورة وننفذ حاجة تانية',
          'مش هنخبّي عنك أي تأخير أو مشكلة في الموقع',
        ],
      },
      faq: [
        {
          q: 'ممكن آخد التصميم بس من غير التنفيذ؟',
          a: 'أيوة. ممكن تاخد التصميم بس، أو التنفيذ بس لتصميم عندك، أو الاتنين مع بعض.',
        },
        {
          q: 'الصور الواقعية دي بتطلع إزاي؟',
          a: 'بتبعتلنا صور المكان زي ما هو، وفريقنا بيصمم وبيستخدم البرامج والذكاء الاصطناعي عشان يطلّع صور قريبة جدًا من الشكل النهائي. وبيراجعها مصمم قبل ما توصلك.',
        },
        {
          q: 'التكلفة المبدئية دقيقة لأي درجة؟',
          a: 'هي تقدير من أول التصميم يساعدك تقرر. بعد ما نثبّت التصميم والخامات بنبعتلك عرض سعر نهائي مكتوب بالجنيه المصري.',
        },
        {
          q: 'بتشتغلوا في شقق بس؟',
          a: 'لأ. بنشتغل في الشقق والفلل والبيوت، من جوه ومن بره، وكمان في أجزاء بس زي مطبخ أو أوضة.',
        },
        {
          q: 'المتابعة على واتساب بتبقى إزاي؟',
          a: 'بتوصلك صور التقدم بانتظام، وأي قرار محتاج موافقتك بيتبعتلك برسالة واضحة ترد عليها، وكل ده بيتحفظ في مكان واحد.',
        },
        {
          q: 'المطبخ والنجارة بتعملوهم عندكم؟',
          a: 'أيوة. المقاسات بتطلع من التصميم، وبنقطّع ونجمّع ونركّب على مقاس مكانك.',
        },
        {
          q: 'ممكن تشتغلوا على حاجة واحدة بس، زي المطبخ؟',
          a: 'أكيد. ابعتلنا صور المكان ومقاساته التقريبية، ونبدأ معاك من هناك.',
        },
      ],
      next: [
        {
          t: 'بنقرا رسالتك',
          d: 'حد من الفريق بيقرا رسالتك بنفسه ويرد عليك.',
        },
        {
          t: 'صور ومعاينة',
          d: 'بنطلب صور المكان أو بنتفق على ميعاد معاينة.',
        },
        {
          t: 'أول تصور وتكلفة',
          d: 'بنبعتلك تصور مبدئي وتكلفة تقريبية بالجنيه تراجعهم براحتك.',
        },
      ],
      closer: {
        h: 'عايز تشوف مكانك بعد التصميم؟',
        p: 'ابعتلنا سطرين عن مكانك واللي محتاجه، وهنرجعلك بالخطوة الجاية.',
      },
    },
    en: {
      tagline: 'Interior and exterior design and full home execution',
      alt: {
        hero: 'An apartment living room at sunset with a beige sofa, warm wood panelling and arched window light falling on the wall.',
        a: 'A custom kitchen with walnut lower cabinets, ivory upper cabinets, slim brass handles and a pale stone counter.',
        b: 'A carpentry bench with neatly stacked cut wood panels, a steel rule, a hand plane and chisels.',
      },
      hero: {
        h1: 'Your home, inside and out, seen before it is built',
        lead: 'We are the design and build team of Ebda AI Studio. We design interiors, exteriors and decor, and execute the whole apartment or house: carpentry, kitchens and all the furniture.',
        cta: 'Tell us about your space',
      },
      what: {
        statement:
          'From the first idea to the last nail, design and build sit with one team, so what you saw on screen is what gets built.',
        groups: [
          {
            id: 'design',
            title: 'Design',
            intro: 'Design fitted to how you live and to your budget, not just a nice picture.',
            items: [
              {
                t: 'Interior design',
                d: 'Layout, materials, colour and lighting for every room, based on how you use it.',
              },
              {
                t: 'Exterior design',
                d: 'Facades, gardens, terraces and balconies that complete the home from outside.',
              },
              {
                t: 'Decor design',
                d: 'Ceilings, walls, floors, lighting and the details that give a space its character.',
              },
              {
                t: 'Pre-decor design',
                d: 'We prepare the space in software before the decor: layout, electrics and plumbing, so the build runs without surprises.',
              },
            ],
          },
          {
            id: 'build',
            title: 'Execution',
            intro:
              'Our team builds what was designed, with an engineer following the work on site.',
            items: [
              {
                t: 'Full apartment or house execution',
                d: 'From the core finishing to handover with the keys in your hand, on a clear schedule.',
              },
              {
                t: 'Carpentry',
                d: 'Doors, built-in wardrobes and wood cladding, measured exactly to your space.',
              },
              {
                t: 'Kitchens',
                d: 'A kitchen designed and built to your space and the way you cook, from cabinets to counter to fittings.',
              },
              {
                t: 'All kinds of furniture',
                d: 'Sofas, beds, tables and shelving made to the size and design we agreed.',
              },
            ],
          },
          {
            id: 'how',
            title: 'How the service works',
            intro:
              'These are things we do for you inside every project, not tools you need to learn.',
            items: [
              {
                t: 'Realistic images from your photos',
                d: 'Send us photos of the space as it is, and we send back realistic images of how it will look after the design.',
              },
              {
                t: 'An early cost estimate in EGP',
                d: 'From the start of the design you know a rough cost in Egyptian pounds, so you decide with the numbers in front of you.',
              },
              {
                t: 'Updates and approvals on WhatsApp',
                d: 'Progress photos and every decision that needs your approval reach you on WhatsApp, and you reply from wherever you are.',
              },
              {
                t: 'Precise cut lists',
                d: 'Kitchen and carpentry measurements come straight from the design, so pieces are cut right the first time.',
              },
              {
                t: 'Walkthrough videos',
                d: 'Walk through your home in a video before it is built and get a feel for the space and the light.',
              },
            ],
          },
        ],
      },
      how: {
        statement:
          'We visit and listen, show you the design as a realistic image before anything is built, then build it and keep you updated at each step.',
        steps: [
          {
            t: 'We listen and see the space',
            d: 'We learn your needs, the way you live and your budget, and measure the space or start from photos you send.',
          },
          {
            t: 'You see the idea as a realistic image',
            d: 'We show you the space after the design in realistic images and a walkthrough video, with an early cost in EGP.',
          },
          {
            t: 'We refine the design together',
            d: 'You adjust until you like it, and the cost updates with every change so you always know where you stand.',
          },
          {
            t: 'We build and keep you updated',
            d: 'Our team builds, and progress photos and decisions that need your approval reach you on WhatsApp.',
          },
          {
            t: 'We hand over the space',
            d: 'We hand it over as you saw it, and go through every detail with you before you accept it.',
          },
        ],
        getLabel: 'What you get',
        get: [
          'Realistic images of your space after the design',
          'A walkthrough video before anything is built',
          'An early cost estimate in EGP from the start',
          'Clear construction drawings and measurements',
          'Updates and approvals on WhatsApp',
          'One engineer responsible for your project',
        ],
      },
      path: {
        label: 'From a photo to a finished home',
        statement:
          'What you see at each stop is what reaches the next one, so nothing gets lost along the way.',
        items: [
          {
            t: 'A photo of your space',
            d: 'You photograph the space as it is and send it to us.',
          },
          {
            t: 'The designed image',
            d: 'We send back realistic images of it after the design.',
          },
          {
            t: 'The early cost',
            d: 'You see a rough cost in EGP while you are still deciding.',
          },
          {
            t: 'The walkthrough',
            d: 'You walk through the space in a video before the first nail.',
          },
          {
            t: 'The build',
            d: 'Cut sizes come from the design, with updates on WhatsApp.',
          },
        ],
      },
      why: {
        statement:
          'Software and AI let you see and decide early, saving the time and money that would otherwise go into changes after the build.',
        edgeLabel: 'What is different',
        points: [
          {
            t: 'See it before you pay for the build',
            d: 'Realistic images and a walkthrough video let you decide by seeing, not by imagining from a drawing.',
          },
          {
            t: 'Know the cost early',
            d: 'An early estimate in EGP that updates with every change, so there is no surprise number at the end.',
          },
          {
            t: 'Cut right the first time',
            d: 'Cut lists come from the design itself, so there is less waste and a tighter fit.',
          },
          {
            t: 'Follow along without site visits',
            d: 'Progress photos and approvals on WhatsApp let you follow your home from work.',
          },
          {
            t: 'One team from start to finish',
            d: 'The people who designed it build it, so no one passes the blame to someone else.',
          },
        ],
        notLabel: 'What we will not do',
        not: [
          'Start building before you approve the design and the cost',
          'Change a material without coming back to you',
          'Show you one image and build something else',
          'Hide a delay or a problem on site from you',
        ],
      },
      faq: [
        {
          q: 'Can I take design only, without the build?',
          a: 'Yes. You can take design only, build only for a design you already have, or both together.',
        },
        {
          q: 'How are the realistic images made?',
          a: 'You send photos of the space as it is. Our team designs it and uses software and AI to produce images very close to the final look, and a designer reviews them before they reach you.',
        },
        {
          q: 'How accurate is the early cost estimate?',
          a: 'It is an estimate from the start of the design to help you decide. Once the design and materials are fixed, we send a final written quote in Egyptian pounds.',
        },
        {
          q: 'Do you only work on apartments?',
          a: 'No. We work on apartments, villas and houses, inside and out, and on single rooms or a kitchen on its own.',
        },
        {
          q: 'How do WhatsApp updates work?',
          a: 'You receive progress photos regularly, and any decision that needs your approval comes as a clear message you reply to. All of it is kept in one place.',
        },
        {
          q: 'Do you make the kitchens and carpentry yourselves?',
          a: 'Yes. Measurements come from the design, and we cut, assemble and install to fit your space.',
        },
        {
          q: 'Can you work on just one thing, like the kitchen?',
          a: 'Of course. Send us photos of the space and rough measurements, and we start from there.',
        },
      ],
      next: [
        {
          t: 'We read your message',
          d: 'A person on the team reads it and replies to you.',
        },
        {
          t: 'Photos or a visit',
          d: 'We ask for photos of the space or agree a time to visit.',
        },
        {
          t: 'A first concept and cost',
          d: 'You get an early concept and a rough cost in EGP to review in your own time.',
        },
      ],
      closer: {
        h: 'Want to see your space after the design?',
        p: 'Send us two lines about your space and what you need, and we will come back with the next step.',
      },
    },
  },
  events: {
    id: 'events',
    images: {
      hero: 'events-hero',
      a: 'events-hall',
      b: 'events-badges',
    },
    ar: {
      tagline: 'تنظيم فعاليات الشركات والمؤتمرات والمعارض',
      alt: {
        hero: 'قاعة مؤتمرات فاضية قبل الفعالية: مسرح مدور عليه منصة كلمة، ومدرجات كراسي، وإضاءة دافية من السقف.',
        a: 'قاعة معرض فاضية بليلة قبل الافتتاح، أجنحة بحيطان عاجي وقواعد عرض تحت إضاءة دهبي وممر واسع في النص.',
        b: 'ترابيزة تسجيل قبل فعالية شركة، عليها صفوف بادجات أسماء فاضية بشرايط دهبي وورد أبيض.',
      },
      hero: {
        h1: 'فعاليتك متنظمة من أول دعوة لحد آخر متابعة',
        lead: 'إحنا فريق تنظيم فعاليات من ابدأ ستوديو للذكاء الاصطناعي. بننظم فعاليات الشركات والمؤتمرات والمعارض وإطلاق المنتجات، وبنمسك التفاصيل كلها عشان فعاليتك تطلع زي ما إنت عايز.',
        cta: 'احكيلنا عن فعاليتك',
      },
      what: {
        statement:
          'التخطيط والدعوات وتسجيل الحضور والتنسيق مع الموردين ويوم الفعالية نفسه، كله عند فريق واحد بخطة واحدة.',
        groups: [
          {
            id: 'events',
            title: 'الفعاليات اللي بننظمها',
            intro: 'كل فعالية ليها هدف، وإحنا بنبدأ من هدفك مش من قالب جاهز.',
            items: [
              {
                t: 'فعاليات الشركات',
                d: 'احتفالات وتجمعات للفريق ولقاءات مع العملاء والشركا، بتنظيم يليق باسم شركتك.',
              },
              {
                t: 'المؤتمرات',
                d: 'تسجيل الحضور والبرنامج والمتحدثين والقاعة، كلها ماشية بجدول واحد.',
              },
              {
                t: 'إطلاق المنتجات',
                d: 'يوم إطلاق بيعرّف الناس بمنتجك ويخلّيهم يتكلموا عنه.',
              },
              {
                t: 'المعارض',
                d: 'تجهيز الأجنحة وحركة الزوار والتسجيل، سواء كنت منظم المعرض أو عارض فيه.',
              },
              {
                t: 'الندوات وورش العمل',
                d: 'قاعة مظبوطة وبرنامج واضح ومواد جاهزة، عشان الحضور يطلعوا بفايدة.',
              },
              {
                t: 'تجمعات الشركات والمجتمع',
                d: 'لقاءات سنوية وتجمعات للأعضاء والجمهور، منظمة من الدعوة للمتابعة.',
              },
            ],
          },
          {
            id: 'guests',
            title: 'الدعوات والحضور',
            intro: 'الحضور بيعرفوا كل اللي محتاجينه في الوقت الصح، وإنت بتعرف مين جاي.',
            items: [
              {
                t: 'دعوات وتأكيد حضور على واتساب',
                d: 'الدعوة بتوصل لكل مدعو على واتساب، والرد بيتسجّل لوحده، وإنت بتشوف العدد أول بأول.',
              },
              {
                t: 'تذكير قبل الفعالية',
                d: 'رسايل تذكير بالميعاد والمكان والاتجاهات قبل الفعالية بوقت مناسب.',
              },
              {
                t: 'صفحة للفعالية وتذاكر',
                d: 'صفحة فيها كل التفاصيل والبرنامج والمتحدثين، ولو الفعالية بتذاكر بيتحجز منها.',
              },
              {
                t: 'تسجيل دخول بالـ QR وبادجات',
                d: 'كل حاضر معاه كود بيتمسح على الباب، وفي فعاليات الشركات بيستلم البادج باسمه على طول.',
              },
            ],
          },
          {
            id: 'planning',
            title: 'التخطيط والتنسيق',
            intro: 'خطة واحدة مكتوبة بيشتغل عليها الكل، من أول مورد لآخر فقرة.',
            items: [
              {
                t: 'برنامج الفعالية بالدقيقة',
                d: 'كل فقرة بميعادها والمسؤول عنها، ونسخة منه عند كل اللي شغالين في اليوم.',
              },
              {
                t: 'تخطيط الميزانية',
                d: 'ميزانية واضحة بالجنيه بند بند، بتتابعها وإنت عارف كل جنيه راح فين.',
              },
              {
                t: 'التنسيق مع الموردين',
                d: 'القاعة والأكل والديكور والصوت والإضاءة والطباعة، بنكلمهم ونتابعهم بدالك.',
              },
            ],
          },
          {
            id: 'after',
            title: 'الصور وبعد الفعالية',
            intro: 'الفعالية مش بتخلص لما الحضور يمشوا.',
            items: [
              {
                t: 'حيطة صور للحضور',
                d: 'الحضور بيرفعوا صورهم من موبايلاتهم، وكلها بتتجمع في مكان واحد.',
              },
              {
                t: 'فيديو لأهم اللحظات',
                d: 'فيديو قصير بأهم لحظات الفعالية، جاهز تنشره.',
              },
              {
                t: 'متابعة بعد الفعالية',
                d: 'رسالة شكر للحضور ومعاها الصور والمواد، واستبيان رأي سريع تعرف منه إيه اللي عجبهم.',
              },
            ],
          },
          {
            id: 'support',
            title: 'خدمات مساندة',
            intro: 'خدمات بنقدمها لوحدها كمان، حتى للأفراح والمناسبات العائلية.',
            items: [
              {
                t: 'الورد وتنسيقه',
                d: 'تنسيق ورد للمسرح والترابيزات والمداخل، يناسب الجو والألوان.',
              },
              {
                t: 'التصوير الفوتوغرافي',
                d: 'تصوير للفعالية أو المناسبة بإضاءة وكادر مدروسين.',
              },
              {
                t: 'التصوير بالفيديو',
                d: 'تغطية بالفيديو ومونتاج، من فيديو قصير لتسجيل كامل.',
              },
            ],
          },
        ],
      },
      how: {
        statement:
          'بنفهم هدف فعاليتك، ونكتب خطة وميزانية واضحة، وبعدين ندير الدعوات والموردين ويوم الفعالية، ونكمّل بعدها.',
        steps: [
          {
            t: 'بنسمعك ونفهم الفعالية',
            d: 'هدف الفعالية ونوعها وتاريخها وعدد الحضور التقريبي.',
          },
          {
            t: 'نكتب الخطة والميزانية',
            d: 'بنرجعلك بخطة وميزانية بالجنيه بند بند، وتعدّل عليهم لحد ما تبقى مرتاح.',
          },
          {
            t: 'ندير الدعوات والموردين',
            d: 'بنبعت الدعوات ونتابع تأكيد الحضور، وبننسق مع كل الموردين على برنامج واحد.',
          },
          {
            t: 'ندير يوم الفعالية',
            d: 'فريقنا موجود من بدري، بيسجّل الحضور بالـ QR ويسلّم البادجات وبيمشّي البرنامج بالدقيقة.',
          },
          {
            t: 'نكمّل بعد الفعالية',
            d: 'بنجمع الصور ونطلّع فيديو أهم اللحظات، وبنبعت رسالة الشكر والاستبيان.',
          },
        ],
        getLabel: 'هتاخد إيه',
        get: [
          'خطة وبرنامج للفعالية بالدقيقة',
          'ميزانية بالجنيه بند بند',
          'دعوات وتأكيد حضور وتذكير على واتساب',
          'تسجيل دخول بالـ QR وبادجات بالأسماء',
          'صور الحضور وفيديو لأهم اللحظات',
          'شخص واحد مسؤول عن فعاليتك من الأول للآخر',
        ],
      },
      path: {
        label: 'قبل وأثناء وبعد الفعالية',
        statement: 'الفعالية عندنا مش يوم واحد، دي رحلة بتبدأ قبلها بأسابيع وبتكمّل بعدها.',
        items: [
          {
            t: 'قبلها بأسابيع',
            d: 'الخطة والميزانية والموردين، وصفحة الفعالية والتذاكر.',
          },
          {
            t: 'قبلها بأيام',
            d: 'الدعوات على واتساب وتأكيد الحضور، وبعدين التذكير.',
          },
          {
            t: 'على الباب',
            d: 'تسجيل دخول بالـ QR والبادجات جاهزة بالأسماء.',
          },
          {
            t: 'أثناء الفعالية',
            d: 'البرنامج ماشي بالدقيقة، والحضور بيرفعوا صورهم.',
          },
          {
            t: 'بعدها',
            d: 'رسالة شكر وصور وفيديو لأهم اللحظات واستبيان سريع.',
          },
        ],
      },
      why: {
        statement:
          'البرامج والذكاء الاصطناعي عندنا بيشيلوا الشغل المتكرر، من تأكيد الحضور للتذكير لتسجيل الدخول، فنركّز إحنا على تفاصيل فعاليتك.',
        edgeLabel: 'اللي بيفرق',
        points: [
          {
            t: 'تعرف مين جاي',
            d: 'تأكيد الحضور على واتساب بيتسجّل لوحده، فبتعرف العدد الحقيقي بدري وتحجز على أساسه.',
          },
          {
            t: 'الحضور مش هيتوهوا',
            d: 'التذكير والمكان والاتجاهات بيوصلوا لكل مدعو في الوقت الصح.',
          },
          {
            t: 'دخول من غير طوابير',
            d: 'تسجيل الدخول بالـ QR والبادجات الجاهزة بيخلّوا الاستقبال سريع ومنظم.',
          },
          {
            t: 'ميزانية من غير مفاجآت',
            d: 'الميزانية مكتوبة بند بند، وأي تغيير بيتعرض عليك قبل ما يحصل.',
          },
          {
            t: 'متابعة بعدها',
            d: 'رسالة شكر واستبيان وصور، فالفعالية بتكمّل تشتغل لك بعد ما تخلص.',
          },
        ],
        notLabel: 'اللي مش هنعمله',
        not: [
          'مش هنتعاقد مع مورد من غير موافقتك',
          'مش هنزوّد بند في الميزانية من غير ما نرجعلك',
          'مش هنستخدم بيانات الحضور في أي حاجة غير فعاليتك',
          'مش هنسيبك لوحدك يوم الفعالية',
        ],
      },
      faq: [
        {
          q: 'بتنظموا فعاليات صغيرة؟',
          a: 'أيوة. بننظم ورش العمل والندوات الصغيرة زي المؤتمرات والمعارض الكبيرة، وبنقترح اللي يناسب حجم فعاليتك.',
        },
        {
          q: 'التكلفة بتبقى كام؟',
          a: 'التكلفة بتختلف حسب نوع الفعالية وعدد الحضور والخدمات. بعد أول مكالمة بنبعتلك ميزانية مكتوبة بالجنيه المصري بند بند.',
        },
        {
          q: 'الدعوات على واتساب بتشتغل إزاي؟',
          a: 'بنبعت لكل مدعو دعوة فيها التفاصيل وزرار للرد، والرد بيتسجّل لوحده، وقبل الفعالية بيوصله تذكير بالميعاد والمكان.',
        },
        {
          q: 'لازم الحضور ينزّلوا تطبيق؟',
          a: 'لأ. الدعوة على واتساب، وصفحة الفعالية وحيطة الصور بيفتحوا من المتصفح على طول.',
        },
        {
          q: 'بتنظموا أفراح؟',
          a: 'إحنا متخصصين في فعاليات الشركات والمؤتمرات والمعارض. للأفراح والمناسبات العائلية بنقدم خدمات مساندة بس: الورد والتصوير الفوتوغرافي والفيديو.',
        },
        {
          q: 'ممكن تشتغلوا مع موردين أنا اخترتهم؟',
          a: 'أكيد. بننسق مع الموردين اللي إنت اخترتهم، أو بنرشحلك موردين لو محتاج.',
        },
        {
          q: 'بيانات الحضور بتروح فين؟',
          a: 'بنستخدم أسماء وأرقام الحضور عشان فعاليتك بس، ومش بنشاركها مع حد.',
        },
      ],
      next: [
        {
          t: 'بنقرا رسالتك',
          d: 'حد من الفريق بيقرا رسالتك بنفسه ويرد عليك.',
        },
        {
          t: 'مكالمة قصيرة',
          d: 'بنتكلم مع بعض عشان نفهم هدف فعاليتك وجمهورها.',
        },
        {
          t: 'خطة وميزانية',
          d: 'بنبعتلك خطة مبدئية وميزانية بالجنيه تراجعهم براحتك.',
        },
      ],
      closer: {
        h: 'عندك فعالية جاية؟',
        p: 'ابعتلنا نوعها وتاريخها التقريبي، وهنرجعلك بخطة واضحة.',
      },
    },
    en: {
      tagline: 'Corporate events, conferences and exhibitions, organised',
      alt: {
        hero: 'An empty auditorium before an event: a round stage with a lectern, tiers of seats and warm light from the ceiling.',
        a: 'An empty exhibition hall the evening before opening, ivory-walled stands, display plinths under gold spotlights and a wide central aisle.',
        b: 'A registration table before a corporate event with rows of blank name badges on gold lanyards and white flowers.',
      },
      hero: {
        h1: 'Your event, organised from the first invitation to the last follow-up',
        lead: 'We are the events team of Ebda AI Studio. We organise corporate events, conferences, exhibitions and product launches, and handle every detail so your event turns out the way you want.',
        cta: 'Tell us about your event',
      },
      what: {
        statement:
          'Planning, invitations, check-in, vendor coordination and the day itself sit with one team, working from one plan.',
        groups: [
          {
            id: 'events',
            title: 'Events we organise',
            intro: 'Every event has a goal; we start from yours, not from a template.',
            items: [
              {
                t: 'Corporate events',
                d: 'Celebrations, team gatherings and evenings with clients and partners, organised in a way that reflects well on your company.',
              },
              {
                t: 'Conferences',
                d: 'Registration, programme, speakers and the hall, all running to one schedule.',
              },
              {
                t: 'Product launches',
                d: 'A launch day that introduces your product and gets people talking about it.',
              },
              {
                t: 'Exhibitions',
                d: 'Stands, visitor flow and registration, whether you run the exhibition or exhibit at it.',
              },
              {
                t: 'Seminars and workshops',
                d: 'The right room, a clear programme and materials ready, so attendees leave with something useful.',
              },
              {
                t: 'Company and community gatherings',
                d: 'Annual meetings and gatherings for members and the public, organised from invitation to follow-up.',
              },
            ],
          },
          {
            id: 'guests',
            title: 'Invitations and attendees',
            intro: 'Attendees know what they need at the right time, and you know who is coming.',
            items: [
              {
                t: 'WhatsApp invitations and RSVP',
                d: 'Each invitee receives the invitation on WhatsApp, replies are recorded automatically, and you see the count as it builds.',
              },
              {
                t: 'Reminders before the event',
                d: 'Reminders with the time, place and directions, sent at the right moment before the event.',
              },
              {
                t: 'Event page and tickets',
                d: 'A page with all the details, the programme and the speakers, with booking when the event is ticketed.',
              },
              {
                t: 'QR check-in and badges',
                d: 'Each attendee has a code scanned at the door, and at corporate events they collect a named badge on the spot.',
              },
            ],
          },
          {
            id: 'planning',
            title: 'Planning and coordination',
            intro:
              'One written plan that everyone works from, from the first vendor to the last item on the programme.',
            items: [
              {
                t: 'Run of show',
                d: 'Every item with its time and the person responsible, and a copy for everyone working on the day.',
              },
              {
                t: 'Budget planning',
                d: 'A clear budget in Egyptian pounds, line by line, so you always know where the money went.',
              },
              {
                t: 'Vendor coordination',
                d: 'Venue, catering, decor, sound, lighting and print: we speak to them and follow up for you.',
              },
            ],
          },
          {
            id: 'after',
            title: 'Photos and after the event',
            intro: 'An event does not end when the attendees leave.',
            items: [
              {
                t: 'Attendee photo wall',
                d: 'Attendees upload photos from their phones, and they all gather in one place.',
              },
              {
                t: 'Highlight reel',
                d: 'A short video of the key moments of the event, ready to publish.',
              },
              {
                t: 'Post-event follow-up',
                d: 'A thank-you message with the photos and materials, and a quick survey that tells you what attendees valued.',
              },
            ],
          },
          {
            id: 'support',
            title: 'Support services',
            intro:
              'Services we also offer on their own, including for weddings and family occasions.',
            items: [
              {
                t: 'Flowers and arrangements',
                d: 'Flower arrangements for the stage, tables and entrances, matched to the mood and colours.',
              },
              {
                t: 'Photography',
                d: 'Photography of the event or occasion with considered light and framing.',
              },
              {
                t: 'Videography',
                d: 'Video coverage and editing, from a short film to a full recording.',
              },
            ],
          },
        ],
      },
      how: {
        statement:
          'We understand the goal of your event, write a clear plan and budget, run the invitations, vendors and the day, and carry on after it.',
        steps: [
          {
            t: 'We listen and understand the event',
            d: 'The goal and type of the event, the date and a rough attendee count.',
          },
          {
            t: 'We write the plan and budget',
            d: 'You get a plan and a line-by-line budget in EGP, and adjust them until you are comfortable.',
          },
          {
            t: 'We run invitations and vendors',
            d: 'We send the invitations, follow the RSVPs and coordinate every vendor on one programme.',
          },
          {
            t: 'We run the day',
            d: 'Our team is there early, checks attendees in by QR, hands out badges and runs the programme to the minute.',
          },
          {
            t: 'We carry on after the event',
            d: 'We gather the photos, make the highlight reel and send the thank-you message and survey.',
          },
        ],
        getLabel: 'What you get',
        get: [
          'A plan and a minute-by-minute run of show',
          'A line-by-line budget in EGP',
          'Invitations, RSVPs and reminders on WhatsApp',
          'QR check-in and named badges',
          'Attendee photos and a highlight reel',
          'One person responsible for your event from start to finish',
        ],
      },
      path: {
        label: 'Before, during and after the event',
        statement: 'For us an event is not one day; it starts weeks before and carries on after.',
        items: [
          {
            t: 'Weeks before',
            d: 'Plan, budget and vendors, plus the event page and tickets.',
          },
          {
            t: 'Days before',
            d: 'WhatsApp invitations and RSVPs, then the reminders.',
          },
          {
            t: 'At the door',
            d: 'QR check-in, with named badges ready.',
          },
          {
            t: 'During the event',
            d: 'The programme runs to the minute while attendees upload photos.',
          },
          {
            t: 'After',
            d: 'A thank-you, photos, a highlight reel and a quick survey.',
          },
        ],
      },
      why: {
        statement:
          'Software and AI take care of the repetitive work, from RSVPs to reminders to check-in, so we can focus on the details of your event.',
        edgeLabel: 'What is different',
        points: [
          {
            t: 'Know who is coming',
            d: 'RSVPs on WhatsApp are recorded automatically, so you know the real count early and book on it.',
          },
          {
            t: 'Attendees do not get lost',
            d: 'Reminders, the venue and directions reach every invitee at the right time.',
          },
          {
            t: 'Entry without queues',
            d: 'QR check-in and ready badges make arrival quick and orderly.',
          },
          {
            t: 'A budget without surprises',
            d: 'The budget is written line by line, and any change is put to you before it happens.',
          },
          {
            t: 'Follow-up that keeps working',
            d: 'A thank-you, a survey and the photos keep the event working for you after it ends.',
          },
        ],
        notLabel: 'What we will not do',
        not: [
          'Contract a vendor without your approval',
          'Add a budget line without coming back to you',
          'Use attendees’ details for anything but your event',
          'Leave you on your own on the day',
        ],
      },
      faq: [
        {
          q: 'Do you organise small events?',
          a: 'Yes. We organise small workshops and seminars as well as large conferences and exhibitions, and suggest what fits the size of yours.',
        },
        {
          q: 'How much does it cost?',
          a: 'It depends on the type of event, the number of attendees and the services. After the first call we send a written, line-by-line budget in Egyptian pounds.',
        },
        {
          q: 'How do WhatsApp invitations work?',
          a: 'Each invitee receives an invitation with the details and a reply button. Replies are recorded automatically, and a reminder with the time and place goes out before the event.',
        },
        {
          q: 'Do attendees need to install an app?',
          a: 'No. The invitation arrives on WhatsApp, and the event page and photo wall open straight in the browser.',
        },
        {
          q: 'Do you organise weddings?',
          a: 'We specialise in corporate events, conferences and exhibitions. For weddings and family occasions we offer support services only: flowers, photography and videography.',
        },
        {
          q: 'Can you work with vendors I chose?',
          a: 'Of course. We coordinate with the vendors you chose, or recommend some if you need them.',
        },
        {
          q: 'What happens to attendees’ details?',
          a: 'We use attendees’ names and numbers for your event only, and do not share them with anyone.',
        },
      ],
      next: [
        {
          t: 'We read your message',
          d: 'A person on the team reads it and replies to you.',
        },
        {
          t: 'A short call',
          d: 'We talk to understand the goal of your event and its audience.',
        },
        {
          t: 'A plan and a budget',
          d: 'You get a first plan and a budget in EGP to review in your own time.',
        },
      ],
      closer: {
        h: 'Have an event coming up?',
        p: 'Send us what it is and the rough date, and we will come back with a clear plan.',
      },
    },
  },
};
