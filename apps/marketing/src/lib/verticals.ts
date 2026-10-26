import { getLook } from '@ebda/shared';
import { DEMO_STORES, demoLookUrl, type DemoTemplate, type Locale } from './site';

/**
 * Per-vertical ad landing pages (/for/<vertical>/, marketing-levelup P2). One page per template, built from the look
 * registry's own `name`/`idea` strings (so the page can never describe a look the product does not have) plus a short
 * vertical headline written here. Nothing on these pages is a claim about results: they show the three looks and the
 * live demo store, then send the visitor to sign-up.
 */
export const VERTICALS = {
  fashion: {
    template: 'qamar',
    ar: {
      h1: 'متجر أزياء بشكل يشبه البوتيك بتاعك.',
      lead: 'صور كبيرة، ولوك كامل في مكان واحد، وفاترينة للمناسبات. اختار الشكل اللي يناسب هدومك، وغيّر الألوان والصور بنفسك.',
      title: 'متجر أزياء أونلاين في دقايق',
      desc: 'ابدأ متجر أزياء بثلاثة أشكال جاهزة: أتيليه، لوك بوك، وفاترينة. صور كبيرة، ولوك كامل في مكان واحد، وتعديل بنفسك من الموبايل.',
    },
    en: {
      h1: 'A fashion store that looks like your boutique.',
      lead: 'Large photography, whole outfits in one place and an occasion window. Pick the look that suits your clothes and change colours and photos yourself.',
      title: 'An online fashion store in minutes',
      desc: 'Open a fashion store with three ready looks: Atelier, Lookbook and Vitrine. Large photos, whole outfits in one place, edit it yourself from your phone.',
    },
  },
  electronics: {
    template: 'souq',
    ar: {
      h1: 'متجر إلكترونيات العميل يلاقي فيه اللي عايزه بسرعة.',
      lead: 'كتالوج بيبدأ بالبحث، وشكل ليلي بدرجات النحاسي، وعرض لمنتج واحد في كل شاشة. اختار الأنسب لمنتجاتك.',
      title: 'متجر إلكترونيات أونلاين في دقايق',
      desc: 'ابدأ متجر إلكترونيات بثلاثة أشكال جاهزة: كتالوج، ليلي، ومعرض. بحث أولًا، وصفحة واضحة لكل منتج، وتعديل بنفسك من الموبايل.',
    },
    en: {
      h1: 'An electronics store where shoppers find what they want fast.',
      lead: 'A search-first catalogue, a night look in brass, and one product per screen. Pick what fits your products.',
      title: 'An online electronics store in minutes',
      desc: 'Open an electronics store with three ready looks: Catalogue, Night and Showroom. Search first, a clear page per product, edit it yourself from your phone.',
    },
  },
  beauty: {
    template: 'jasmine',
    ar: {
      h1: 'متجر عناية وجمال بيحكي عن مكوّنات منتجاتك.',
      lead: 'ثلاثة أشكال: صيدلية للمكوّنات، وبلوم للدرجات واللون، وكلينيك لروتين البشرة. اختار اللي يشبه علامتك.',
      title: 'متجر عناية وجمال أونلاين في دقايق',
      desc: 'ابدأ متجر عناية وجمال بثلاثة أشكال جاهزة: صيدلية، بلوم، وكلينيك. تعديل بنفسك من الموبايل وصور وألوان على ذوقك.',
    },
    en: {
      h1: 'A beauty store that tells the story of your ingredients.',
      lead: 'Three looks: an apothecary for ingredients, a bloom for shades and colour, a clinic for skin routines. Pick the one that suits your brand.',
      title: 'An online beauty store in minutes',
      desc: 'Open a beauty store with three ready looks: Apothecary, Bloom and Clinic. Edit it yourself from your phone, with photos and colours to your taste.',
    },
  },
  food: {
    template: 'lamma',
    ar: {
      h1: 'متجر أكل بيتي العميل يطلب منه زي المنيو.',
      lead: 'ثلاثة أشكال: سفرة بمنيو واضح، وكراسة بحكاية صاحبة المطبخ، وسوق للبقالة والخضار. اختار اللي يناسب أكلك.',
      title: 'متجر أكل أونلاين في دقايق',
      desc: 'ابدأ متجر أكل بثلاثة أشكال جاهزة: سفرة، كراسة، وسوق. منيو واضح، وطلب بسهولة، وتعديل بنفسك من الموبايل.',
    },
    en: {
      h1: 'A home-food store customers order from like a menu.',
      lead: "Three looks: a table with a clear menu, a notebook with the cook's story, and a market for groceries. Pick what suits your food.",
      title: 'An online food store in minutes',
      desc: 'Open a food store with three ready looks: Table, Notebook and Market. A clear menu, easy ordering, edit it yourself from your phone.',
    },
  },
  jewellery: {
    template: 'dahab',
    ar: {
      h1: 'متجر مجوهرات القطعة فيه باينة على اللي لابسها.',
      lead: 'ثلاثة أشكال: قطع متلبسة، وورشة بتتعمل قطعة قطعة، وعلبة هدايا بحسب الشخص والميزانية. اختار الأنسب لدهبك أو فضتك.',
      title: 'متجر مجوهرات أونلاين في دقايق',
      desc: 'ابدأ متجر مجوهرات بثلاثة أشكال جاهزة: متلبسة، ورشة، وعلبة هدايا. صور كبيرة وتعديل بنفسك من الموبايل.',
    },
    en: {
      h1: 'A jewellery store where every piece is shown worn.',
      lead: 'Three looks: pieces worn, a workshop where each piece is made, and a gift box by person and budget. Pick what fits your gold or silver.',
      title: 'An online jewellery store in minutes',
      desc: 'Open a jewellery store with three ready looks: Worn, Workshop and Gift box. Large photos, edit it yourself from your phone.',
    },
  },
} as const satisfies Record<
  string,
  {
    template: DemoTemplate;
    ar: { h1: string; lead: string; title: string; desc: string };
    en: { h1: string; lead: string; title: string; desc: string };
  }
>;
export type VerticalSlug = keyof typeof VERTICALS;
export const VERTICAL_SLUGS = Object.keys(VERTICALS) as VerticalSlug[];
export type VerticalPageSlug = `for/${VerticalSlug}`;

/** The three looks of a vertical, from the registry: name and idea in the page's language, and the live demo link. */
export function verticalLooks(slug: VerticalSlug, locale: Locale) {
  const t = VERTICALS[slug].template;
  return DEMO_STORES[t].looks.map(l => {
    const look = getLook(`${t}.${l}`);
    if (!look) throw new Error(`vertical ${slug}: no look ${t}.${l} in the registry`);
    return {
      id: look.id,
      name: look.name[locale],
      idea: look.idea[locale],
      href: demoLookUrl(t, l),
    };
  });
}
