import type { LookDefinition, LookTemplate } from './types';

// ORDER is product behaviour (Ruling B5-25): it is the order of the admin picker's tabs, of the demo bar
// and, through `defaultNewStoreLook`, which look a store gets when none is asked for. Qamar stays first;
// Dahab, flipped to built last, is last.
export const LOOK_TEMPLATES: readonly LookTemplate[] = [
  'qamar',
  'souq',
  'jasmine',
  'lamma',
  'dahab',
];

const L = (d: LookDefinition) => d;

export const LOOKS: readonly LookDefinition[] = [
  L({
    id: 'qamar.atelier',
    template: 'qamar',
    letter: 'A',
    skin: 'qamar',
    status: 'built',
    chrome: { header: { logoPlacement: 'start' } },
    // Ruling B1-3. Category row as text chips, image break full-bleed (plan amendment C1).
    // The carousel preset is `newest`, never a demo category slug (C7).
    sections: [
      // L-04: the copy sits at the bottom-start corner, off the model (W2a).
      { type: 'hero', design: { presentation: 'full-bleed', textAnchor: 'bottom-start' } },
      // A chip row is navigation, not a showcase: tight above, no padding below, so it sits
      // right under the hero instead of in 200px of air (STOP 1 critique).
      {
        type: 'category-grid',
        design: {
          layout: 'chips',
          layoutMobile: 'chips',
          paddingTop: 'tight',
          paddingBottom: 'none',
        },
      },
      {
        type: 'featured-collection',
        design: { columns: 4, mobileColumns: 2 },
        preset: { productSource: 'newest', limit: 8, heading: 'New in', headingAr: 'وصل حديثًا' },
      },
      // T7: the template's signature section, after the main grid (filled by the merchant or the demo seed).
      { type: 'editorial-collage' },
      { type: 'image-text', design: { layout: 'full-bleed' } },
      { type: 'product-carousel', preset: { productSource: 'newest', limit: 12 } },
      { type: 'brand-story' },
    ],
    name: { ar: 'أتيليه', en: 'Atelier' },
    forWhom: { ar: 'لبوتيك هدومه بتتكلم لوحدها.', en: 'For a boutique whose clothes speak alone.' },
    idea: {
      ar: 'صور كبيرة وواجهة قليلة: الهدوم هي الواجهة.',
      en: 'Oversized photography, almost no chrome.',
    },
    tokens: {
      page: '#FFFFFF',
      surface: '#FFFFFF',
      ink: '#141414',
      muted: '#5C5C5C',
      primary: '#141414',
      onPrimary: '#FFFFFF',
      accent: '#6E1F2A',
      line: '#E6E6E6',
      fonts: {
        display: 'Noto Naskh Arabic',
        body: 'IBM Plex Sans Arabic',
        latin: 'Cormorant Garamond',
      },
      radius: 'none',
      density: 'airy',
      imageRatio: '3/4',
      motion: 'subtle',
      // W2a token plumbing (fix-waves W2 #1): a wordmark that leads the header (T-01), over-photo
      // controls as a bare glyph (L-12, read by the card in W2b) and the receipt as framed paper
      // in the page ink (K-07, W3).
      wordmarkSize: 'lg',
      overPhotoChrome: 'bare',
      receiptStyle: 'framed',
      // W2b: the photo is the card (L-01: no control, the card is the link), no hover lift (M-03),
      // sale/new chips in the oxblood accent on the square radius (K-01).
      cardCta: 'none',
      cardHover: 'none',
      cardBadge: 'accent',
    },
  }),
  L({
    id: 'qamar.lookbook',
    template: 'qamar',
    letter: 'B',
    skin: 'qamar',
    status: 'built',
    chrome: { header: { logoPlacement: 'start' } },
    // Ruling B1-3 / B1-2: the collage hero and shop-the-look lead; categories scroll as a photo
    // row. No hero `mode` (slideshow vs single is the merchant's content): a collage needs three
    // slide photos and falls back to the banner/slider below that.
    sections: [
      { type: 'hero', design: { presentation: 'collage' } },
      { type: 'shop-the-look', design: { bgColor: 'token:card' } },
      {
        type: 'category-grid',
        // A scrolling photo row at every width; when the catalogue is short the platform strip
        // centres itself instead of leaving an empty tail (CategoryStrip, quality bar L-05).
        // LB-01 (W2a): merchant photos are shot on white, so the categories and the new-in grid
        // sit on ONE light band (the inverse surface: the page ink as ground, indigo text);
        // indigo keeps the header, hero, looks, reviews and footer.
        design: {
          layout: 'horizontal',
          layoutMobile: 'horizontal',
          captionPosition: 'below',
          bgColor: 'token:inverse',
          // LB-06: the row and the new-in grid share one band; no dead band under the captions.
          paddingBottom: 'tight',
        },
      },
      {
        type: 'featured-collection',
        design: { columns: 4, mobileColumns: 2, bgColor: 'token:inverse' },
        preset: { productSource: 'newest', limit: 8, heading: 'New in', headingAr: 'وصل حديثًا' },
      },
      { type: 'testimonials' },
    ],
    name: { ar: 'لوك بوك', en: 'Lookbook' },
    forWhom: {
      ar: 'للستايلست والمحلات اللي بتبيع لوك كامل.',
      en: 'For stylists who sell whole outfits.',
    },
    // Each piece is a link to its PDP (Ruling B1-6): the copy promises no one-tap "add the look".
    idea: { ar: 'كل لوك وقطعه في مكان واحد.', en: 'Each outfit and its pieces in one place.' },
    tokens: {
      page: '#1E2340',
      surface: '#2A3158',
      ink: '#F4F1FA',
      muted: '#C3C0D8',
      primary: '#D9DCEB',
      onPrimary: '#1E2340',
      accent: '#D9DCEB',
      line: '#3B4270',
      fonts: { display: 'Lalezar', body: 'Tajawal', latin: 'Archivo' },
      radius: 'md',
      density: 'regular',
      imageRatio: '4/5',
      motion: 'expressive',
      // T-01: the wordmark leads the header (it was 12px tracked caps).
      wordmarkSize: 'lg',
      // W2b: no accent slab under every card (L-01: only a simple in-stock piece gets an outline
      // add); the heart is a white disc with FIXED ink, never the page's light foreground (LB-02,
      // 1.12:1 before); chips in moon silver with indigo ink (K-01, B1-102). The hover lift stays (expressive).
      cardCta: 'quiet',
      overPhotoChrome: 'soft',
      cardBadge: 'accent',
    },
  }),
  L({
    id: 'qamar.vitrine',
    template: 'qamar',
    letter: 'C',
    skin: 'qamar',
    status: 'built',
    chrome: { header: { logoPlacement: 'centre' } },
    // Occasion first (Ruling B1-2/B1-5): a framed hero whose hairline draws in once, occasion
    // bands, the window of new pieces, one customer line. No hero `mode` (plan amendment C6): the
    // merchant's slider/single choice is content and survives a look switch.
    sections: [
      // VT-02: the copy leaves the window display (the dress) clear (W2a).
      {
        type: 'hero',
        design: { presentation: 'framed', frame: 'line', textAnchor: 'bottom-start' },
      },
      {
        type: 'collection-list',
        design: { tileShape: 'band' },
        preset: { heading: 'Shop by occasion', headingAr: 'تسوّق حسب المناسبة' },
      },
      {
        type: 'featured-collection',
        design: { columns: 4, mobileColumns: 2 },
        preset: {
          productSource: 'newest',
          limit: 8,
          heading: 'In the window',
          headingAr: 'في الفاترينة',
        },
      },
      // T7: the template's signature section, after the main grid (filled by the merchant or the demo seed).
      { type: 'editorial-collage' },
      { type: 'testimonials', design: { layout: 'single' } },
    ],
    name: { ar: 'فاترينة', en: 'Vitrine' },
    forWhom: { ar: 'لهدوم المناسبات: فرح وخطوبة وسهرة.', en: 'For occasion wear.' },
    idea: { ar: 'تسوّق حسب المناسبة.', en: 'Occasion-first navigation.' },
    tokens: {
      page: '#F5F5F6',
      surface: '#FFFFFF',
      ink: '#1A1A1F',
      muted: '#55555E',
      primary: '#1F4E54',
      onPrimary: '#FFFFFF',
      // VT-03 (W2a): the brief's dusty rose, carrying ink (6.23:1), not a darkened brick under white.
      accent: '#C98B8B',
      onAccent: '#1A1A1F',
      // Champagne as the line role (Ruling B1-5): hairlines, the hero frame, the third band.
      line: '#D8B96A',
      fonts: { display: 'Aref Ruqaa', body: 'Noto Sans Arabic', latin: 'Playfair Display' },
      radius: 'sm',
      density: 'regular',
      imageRatio: '3/4',
      motion: 'subtle',
      // The centred Ruqaa wordmark at its current size (24/30px), now also on checkout/success.
      wordmarkSize: 'xl',
      // W2b: one label system in a row (L-01: no "View" next to "Add to cart"), a still card
      // (motion subtle, M-03), the heart on a disc with fixed ink, rose chips with ink (K-01).
      cardCta: 'quiet',
      cardHover: 'none',
      overPhotoChrome: 'soft',
      cardBadge: 'accent',
    },
  }),
  L({
    id: 'souq.catalogue',
    template: 'souq',
    letter: 'A',
    skin: 'souq',
    status: 'built',
    chrome: { header: { logoPlacement: 'start', search: 'prominent' }, plp: 'autoFill' },
    // Ruling B2-16. Search first, no hero: the first screen is the search field and the category
    // rail, then today's deals, a dense newest grid and the trust line. Carousel headings use the
    // extra-carousel `title` keys; strings are Egyptian, controls neutral.
    sections: [
      {
        type: 'category-grid',
        design: {
          layout: 'rail',
          layoutMobile: 'rail',
          paddingTop: 'tight',
          paddingBottom: 'tight',
        },
      },
      {
        type: 'product-carousel',
        // STOP-2 minor: ~150px of dead air between the rail and this row
        design: { paddingTop: 'tight' },
        preset: {
          productSource: 'on_sale',
          limit: 8,
          title: 'Deals today',
          titleAr: 'عروض النهاردة',
        },
      },
      {
        type: 'featured-collection',
        design: { columns: 4, mobileColumns: 2 },
        preset: { productSource: 'newest', limit: 12, heading: 'New in', headingAr: 'لسه واصل' },
      },
      // T7: the template's signature section, after the main grid (filled by the merchant or the demo seed).
      { type: 'spec-sheet' },
      { type: 'trust-strip' },
      { type: 'newsletter' },
    ],
    name: { ar: 'كتالوج', en: 'Catalogue' },
    forWhom: {
      ar: 'لمحل فيه أصناف كتير والزبون عارف عايز إيه.',
      en: 'For many SKUs and shoppers who know what they want.',
    },
    idea: { ar: 'توصل للي عايزه في ضغطتين.', en: 'Find it in two taps.' },
    tokens: {
      page: '#FFFFFF',
      surface: '#F5F7FA',
      ink: '#10151C',
      muted: '#555D69',
      primary: '#1F5FD6',
      onPrimary: '#FFFFFF',
      accent: '#1F5FD6',
      line: '#E2E6EC',
      fonts: {
        display: 'IBM Plex Sans Arabic',
        body: 'IBM Plex Sans Arabic',
        latin: 'IBM Plex Sans',
      },
      radius: 'md',
      density: 'compact',
      imageRatio: '1/1',
      motion: 'subtle',
      // Ruling B2-1: the sale / new chips read the accent pair; the card keeps the skin's
      // quick-add system (no cardCta), so a catalogue card has one action.
      cardBadge: 'accent',
      // T-01: the store name is a sized, untracked wordmark in the header and at checkout.
      wordmarkSize: 'lg',
    },
  }),
  L({
    id: 'souq.night',
    template: 'souq',
    letter: 'B',
    skin: 'souq',
    status: 'built',
    chrome: {
      header: { logoPlacement: 'start', search: 'icon' },
      plp: 'autoFill',
      listing: 'ground',
    },
    // Ruling B2-16, amended by B2-24 (STOP-2 taste audit): a lit market that stays GREEN on every
    // page. A full-bleed hero, bold square category tiles (four across, a brass hairline), the
    // curated and deals rows and the dense grid all on the green ground; merchant photos shot on
    // white sit on a cream matte (multiply, globals.css) so they never read as white rectangles
    // (quality bar section 9 rule 1 is met by the matte, not by a light band).
    sections: [
      { type: 'hero', design: { presentation: 'full-bleed', textAnchor: 'bottom-start' } },
      // STOP-2 taste audit: the lantern hero carries no product, so ONE featured product follows it
      // as a stage (cut-out, two facts, price, add): the photo-led screen the brief asks for.
      {
        type: 'product-spotlight',
        design: { layout: 'stage', paddingTop: 'tight', paddingBottom: 'tight' },
        preset: { productSource: 'featured', limit: 1, heading: '', headingAr: '' },
      },
      {
        type: 'category-grid',
        design: {
          layout: 'tiles',
          layoutMobile: 'tiles',
          captionPosition: 'below',
          desktopColumns: 4,
          mobileColumns: 2,
          paddingBottom: 'tight',
        },
      },
      {
        type: 'product-carousel',
        design: { paddingTop: 'tight', paddingBottom: 'tight' },
        preset: { productSource: 'manual', limit: 8, title: 'From the souq', titleAr: 'من السوق' },
      },
      {
        type: 'product-carousel',
        design: { paddingTop: 'tight', paddingBottom: 'tight' },
        preset: { productSource: 'on_sale', limit: 8, title: 'Deals', titleAr: 'عروض' },
      },
      {
        type: 'featured-collection',
        design: { columns: 4, mobileColumns: 2 },
        preset: { productSource: 'newest', limit: 8, heading: 'New in', headingAr: 'جديد السوق' },
      },
      // T7: the template's signature section, after the main grid (filled by the merchant or the demo seed).
      { type: 'spec-sheet' },
      { type: 'trust-strip' },
      { type: 'brand-story' },
    ],
    name: { ar: 'سوق الليل', en: 'Night souq' },
    forWhom: {
      ar: 'لتاجر عايز دفا وشخصية.',
      en: 'For a retailer who wants warmth and personality.',
    },
    idea: { ar: 'سوق منوّر من غير زحمة.', en: 'Lit and alive without clutter.' },
    tokens: {
      page: '#0F3B2E',
      surface: '#14503F',
      ink: '#F6F3EA',
      muted: '#B4CDC0',
      // Ruling B2-18 (Ahmad, STOP-1, 2026-10-21): Night souq's CTAs are BRASS #C89B3C (4.87:1 on the
      // page, 3.5+:1 on the card) with dark ink on it, the lantern-market warmth. This is the ONE
      // scoped exception to the no-orange gate (B2-2): exactly this hex, only as `souq.night`'s
      // primary CTA tokens (see tests/unit/souq-look-tokens.test.ts, BRASS_CTA_EXCEPTION). Everything
      // else in Night stays out of the 12-50 degree band. Ruling B2-26 (controller, from Ahmad's taste
      // profile: metal is the accent on deep grounds): the sale / new / custom chips and the PDP
      // discount pill are ALSO brass, read through `--chip-bg` = the primary pair (globals.css), so
      // the look has ONE accent and no coral. The `accent` token below (pomegranate) stays as the
      // look's declared secondary fill for status UI, never painted on a chip.
      primary: '#C89B3C',
      onPrimary: '#10151C',
      accent: '#F57A83',
      onAccent: '#10151C',
      line: '#1E5A48',
      fonts: { display: 'Changa', body: 'Cairo', latin: 'Manrope' },
      radius: 'md',
      density: 'regular',
      imageRatio: '1/1',
      motion: 'expressive',
      // Quality bar section 9: controls on a product photo take their own on-token.
      overPhotoChrome: 'soft',
      cardBadge: 'accent',
      // T-01: the store name is a sized, untracked wordmark in the header and at checkout.
      wordmarkSize: 'lg',
    },
  }),
  L({
    id: 'souq.showroom',
    template: 'souq',
    letter: 'C',
    skin: 'souq',
    status: 'built',
    chrome: { header: { logoPlacement: 'start', search: 'icon' }, plp: 'autoFill' },
    // Ruling B2-16. The product is the hero: categories as chips right under the header (the
    // first screen shows categories), up to three one-product stages (the first reads the store's
    // featured pool so a new store has a stage; the others are hand-picked and render NOTHING
    // until filled), a hand-picked collection list of rectangles on the surface (the plan's second
    // category-grid is impossible: category-grid has cardinality one), a 2-column grid, trust.
    sections: [
      {
        type: 'category-grid',
        design: {
          layout: 'chips',
          layoutMobile: 'chips',
          paddingTop: 'tight',
          paddingBottom: 'none',
        },
      },
      {
        type: 'product-spotlight',
        design: { layout: 'stage', paddingTop: 'tight' },
        // heading '' : the registry's first spotlight preset is "Gift ideas"; a stage has no kicker
        preset: { productSource: 'featured', limit: 1, heading: '', headingAr: '' },
      },
      {
        type: 'product-spotlight',
        design: { layout: 'stage' },
        preset: { productSource: 'manual', limit: 1, heading: '', headingAr: '' },
      },
      {
        type: 'product-spotlight',
        design: { layout: 'stage' },
        preset: { productSource: 'manual', limit: 1, heading: '', headingAr: '' },
      },
      {
        type: 'collection-list',
        design: { tileShape: 'rectangle', bgColor: 'token:card' },
        preset: { heading: 'Shop by category', headingAr: 'تسوّق حسب القسم' },
      },
      {
        type: 'featured-collection',
        design: { columns: 4, mobileColumns: 2 },
        preset: {
          productSource: 'newest',
          limit: 8,
          heading: 'All products',
          headingAr: 'كل المنتجات',
        },
      },
      // T7: the template's signature section, after the main grid (filled by the merchant or the demo seed).
      { type: 'spec-sheet' },
      { type: 'trust-strip' },
    ],
    name: { ar: 'شو روم', en: 'Showroom' },
    forWhom: {
      ar: 'لمجموعة صغيرة فاخرة بتتباع قطعة قطعة.',
      en: 'For a small premium range sold one object at a time.',
    },
    idea: { ar: 'المنتج هو البطل.', en: 'Product as hero.' },
    tokens: {
      page: '#F2F3F5',
      surface: '#FFFFFF',
      ink: '#0B0C0E',
      muted: '#565B63',
      primary: '#1D5CE6',
      onPrimary: '#FFFFFF',
      accent: '#1757E8',
      line: '#DFE2E7',
      fonts: { display: 'Alexandria', body: 'Readex Pro', latin: 'Inter Tight' },
      radius: 'lg',
      density: 'airy',
      imageRatio: '1/1',
      motion: 'subtle',
      // The product is the hero: no accent slab under every card, one quiet action. NOT the
      // `quiet` card-CTA mode (it hides the control on a sized product, so a variant card had no
      // action at all, STOP-2 re-audit): every card keeps its View / Add control, restyled as an
      // outline by the Showroom rule in globals.css.
      cardBadge: 'accent',
      // T-01: the store name is a sized, untracked wordmark in the header and at checkout.
      wordmarkSize: 'lg',
    },
  }),
  L({
    id: 'jasmine.apothecary',
    template: 'jasmine',
    letter: 'A',
    skin: 'jasmine',
    status: 'built',
    // Ruling B3-1: logo-forward header, the skin's own icon search (beauty is bought by brand trust).
    chrome: { header: { logoPlacement: 'start', search: 'icon' }, listing: 'ground' },
    // Ruling B3-1/B3-2, plan Task 4: ingredients first. The hero is the bottle with its
    // ingredients (the mobile hero is already capped at 45vh by HeroBanner), the skin-type chips
    // sit directly under it so the first screen shows a path to the shelf, the product rows live
    // on the LIGHT band (inverse: quality bar section 9 rule 1, merchant photos are shot on
    // white), then the ritual (the real three steps) and the trust strip. Strings are Egyptian,
    // controls neutral. The listing pages keep the olive ground (`chrome.listing: 'ground'`): the
    // photos sit on a paper matte, as on Night souq (fix wave 1, taste P2).
    sections: [
      { type: 'hero', design: { presentation: 'full-bleed', textAnchor: 'bottom-start' } },
      {
        type: 'category-grid',
        design: {
          source: 'tags',
          layout: 'chips',
          layoutMobile: 'chips',
          paddingTop: 'tight',
          paddingBottom: 'none',
        },
        preset: { title: 'By your skin type', titleAr: 'حسب نوع بشرتك' },
      },
      {
        type: 'featured-collection',
        design: { columns: 4, mobileColumns: 2, bgColor: 'token:inverse' },
        preset: {
          productSource: 'newest',
          limit: 8,
          heading: 'Ingredients you know',
          headingAr: 'مكوّنات تعرفها',
        },
      },
      // T7: the template's signature section, after the main grid (filled by the merchant or the demo seed).
      { type: 'key-ingredients' },
      // the ritual is the real three-step routine (fix wave 1, taste P2: one jar photo and a
      // sentence was not "ingredients first"); the same `steps` section Clinic uses
      {
        type: 'steps',
        preset: { heading: 'The ritual', headingAr: 'الطقس' },
      },
      { type: 'trust-strip' },
    ],
    name: { ar: 'عطارة', en: 'Apothecary' },
    forWhom: {
      ar: 'للعناية الطبيعية اللي الثقة فيها من مكوناتها.',
      en: 'For natural skincare trusted for its ingredients.',
    },
    idea: { ar: 'المكونات الأول، وبعدين المنتج.', en: 'Ingredients first.' },
    tokens: {
      // Ruling B3-2: the plan's brown ground (#2E2A22, 41 deg, HSV sat 26%) is inside the
      // no-orange band by the B2 gate's measurement, so the ground is re-derived to a true olive
      // (82 deg); text stays the paper cream (5% chroma). The CTA is the Night-souq brass
      // (B2-18), the ONE scoped exception, with olive-black ink on it (7.0:1). The accent is a
      // jade for status UI; the sale / new chips read the brass (--chip-bg, globals.css).
      page: '#24291C',
      surface: '#2E3425',
      ink: '#F3EFE6',
      muted: '#C9CDB8',
      primary: '#C89B3C',
      onPrimary: '#14180F',
      accent: '#8FC9AE',
      onAccent: '#14180F',
      line: '#4A5240',
      fonts: { display: 'Amiri', body: 'Noto Sans Arabic', latin: 'Fraunces' },
      radius: 'sm',
      density: 'regular',
      imageRatio: '4/5',
      motion: 'subtle',
      // Quality bar section 9: controls on a product photo take their own on-token.
      overPhotoChrome: 'soft',
      cardBadge: 'accent',
      wordmarkSize: 'lg',
    },
  }),
  L({
    id: 'jasmine.bloom',
    template: 'jasmine',
    letter: 'B',
    skin: 'jasmine',
    status: 'built',
    // Ruling B3-1: logo-forward header, the skin's own icon search (beauty is bought by brand trust).
    chrome: { header: { logoPlacement: 'start', search: 'icon' } },
    // Plan Task 4: colour is the page. A framed hero, a rail of "start here" tiles, the weekly
    // routine (curated), the shade-dot grid (2 across on a phone, radius 12 from the token), the
    // customer-photo strip (merchant content, nothing until filled), a deals row and trust.
    sections: [
      // frame 'line' draws the frame: the photo FILLS it (cover, the look's radius) instead of
      // letterboxing on the muted ground, and textAnchor puts the headline on the scrim (white on
      // the photo, ink and a solid primary button under it below xl): fix wave 1, taste P1.
      {
        type: 'hero',
        design: { presentation: 'framed', frame: 'line', textAnchor: 'bottom-start' },
      },
      {
        type: 'category-grid',
        design: {
          layout: 'rail',
          layoutMobile: 'rail',
          paddingTop: 'tight',
          paddingBottom: 'tight',
        },
        preset: { title: 'Start here', titleAr: 'ابدأ من هنا' },
      },
      {
        type: 'product-carousel',
        design: { paddingTop: 'tight', paddingBottom: 'tight' },
        preset: {
          productSource: 'manual',
          limit: 8,
          title: 'This week routine',
          titleAr: 'روتين الأسبوع',
        },
      },
      {
        type: 'featured-collection',
        // 4 across fills the 8 newest (a 3-column grid left a two-card last row)
        design: { columns: 4, mobileColumns: 2 },
        preset: {
          productSource: 'newest',
          limit: 8,
          heading: 'All shades',
          headingAr: 'كل الدرجات',
        },
      },
      // T7: the template's signature section, after the main grid (filled by the merchant or the demo seed).
      { type: 'key-ingredients' },
      { type: 'testimonials' },
      {
        type: 'product-carousel',
        design: { paddingTop: 'tight', paddingBottom: 'tight' },
        preset: { productSource: 'on_sale', limit: 8, title: 'Deals', titleAr: 'عروض' },
      },
      { type: 'trust-strip' },
    ],
    name: { ar: 'بلوم', en: 'Bloom' },
    forWhom: {
      ar: 'للمكياج وجمهور صغير بيختار بالدرجة.',
      en: 'For colour cosmetics chosen by shade.',
    },
    idea: { ar: 'لون المنتج هو لون الصفحة.', en: 'The product colour is the page colour.' },
    tokens: {
      page: '#F6D7DC',
      surface: '#FFFFFF',
      ink: '#3A1E2A',
      muted: '#66404E',
      primary: '#B0154F',
      onPrimary: '#FFFFFF',
      accent: '#B0154F',
      line: '#E9C0C8',
      fonts: { display: 'Rubik', body: 'Tajawal', latin: 'DM Sans' },
      radius: 'lg',
      density: 'regular',
      imageRatio: '1/1',
      motion: 'expressive',
      // Ruling B3-3: raspberry is the fill (white on it 6.8:1) and, at #B0154F, also the text
      // role on the blush page (5.1:1; the plan's #C2185B measured 4.3).
      cardBadge: 'accent',
      wordmarkSize: 'lg',
    },
  }),
  L({
    id: 'jasmine.clinic',
    template: 'jasmine',
    letter: 'C',
    skin: 'jasmine',
    status: 'built',
    // Ruling B3-1: logo-forward header, the skin's own icon search (beauty is bought by brand trust).
    chrome: { header: { logoPlacement: 'start', search: 'icon' } },
    // Plan Task 4: the routine is the navigation. The concern chips come first, directly under the
    // header, the featured active right under them (the first screen is a path AND a photo), then the
    // real 3-step routine, the actives grid on the aqua surface, trust and the newsletter.
    sections: [
      {
        type: 'category-grid',
        design: {
          source: 'tags',
          layout: 'chips',
          layoutMobile: 'chips',
          paddingTop: 'tight',
          paddingBottom: 'none',
        },
        preset: { title: 'Pick your concern', titleAr: 'اختار مشكلتك' },
      },
      // the featured active right under the chips: the first screen has a photo (fix wave 1, P2)
      {
        type: 'product-spotlight',
        design: { layout: 'stage', paddingTop: 'tight', paddingBottom: 'tight' },
        preset: {
          productSource: 'featured',
          limit: 1,
          heading: 'Active of the week',
          headingAr: 'مادة الأسبوع',
        },
      },
      {
        type: 'steps',
        preset: { heading: 'Your routine in 3 steps', headingAr: 'روتينك في 3 خطوات' },
      },
      {
        type: 'featured-collection',
        design: { columns: 4, mobileColumns: 2, bgColor: 'token:card' },
        preset: {
          productSource: 'newest',
          limit: 8,
          heading: 'Actives',
          headingAr: 'المواد الفعّالة',
        },
      },
      // T7: the template's signature section, after the main grid (filled by the merchant or the demo seed).
      { type: 'key-ingredients' },
      { type: 'trust-strip' },
      { type: 'newsletter' },
    ],
    name: { ar: 'عيادة', en: 'Clinic' },
    forWhom: {
      ar: 'للمواد الفعالة لما الزبون عنده مشكلة يحلها.',
      en: 'For actives that solve a concern.',
    },
    idea: { ar: 'الروتين هو القائمة.', en: 'The routine is the navigation.' },
    tokens: {
      page: '#FFFFFF',
      surface: '#E6F5F2',
      ink: '#13212B',
      muted: '#4A5862',
      primary: '#1B7A67',
      onPrimary: '#FFFFFF',
      accent: '#1B7A67',
      line: '#D3E8E3',
      fonts: { display: 'Readex Pro', body: 'Readex Pro', latin: 'Figtree' },
      radius: 'md',
      density: 'airy',
      imageRatio: '1/1',
      motion: 'subtle',
      // Ruling B3-3: the mint green is darkened to #1B7A67 so it reads as text on the aqua band
      // (4.65:1; the plan's #1E7F6B measured 4.35) and as the primary button (5.2:1 with white).
      cardCta: 'quiet',
      cardBadge: 'accent',
      wordmarkSize: 'lg',
    },
  }),
  L({
    id: 'lamma.table',
    template: 'lamma',
    letter: 'A',
    skin: 'lamma',
    status: 'built',
    chrome: {
      header: { logoPlacement: 'start' },
      cartBar: 'total',
      cardStepper: 'inline',
    },
    // Ruling B4-1 (Family table). Order like a menu: a full-bleed food photo (the delivery line is
    // merchant content, B4-12), "order again" for a returning customer (nothing for anyone else), the
    // dishes as rows grouped by category under sticky tabs, the cook as a strip and the trust line.
    sections: [
      // textAnchor: the copy sits under the photo on a phone (taste rule 7: text never covers the food)
      { type: 'hero', design: { presentation: 'full-bleed', textAnchor: 'bottom-start' } },
      {
        type: 'product-carousel',
        preset: {
          productSource: 'reorder',
          limit: 8,
          title: 'Order again',
          titleAr: 'اطلب تاني',
        },
      },
      {
        type: 'featured-collection',
        design: { layout: 'menu', tabs: 'categories', paddingTop: 'tight' },
        preset: {
          productSource: 'newest',
          limit: 24,
          heading: "Today's menu",
          headingAr: 'منيو النهاردة',
        },
      },
      // T7: the template's signature section, after the main grid (filled by the merchant or the demo seed).
      { type: 'kitchen-days' },
      { type: 'maker-profile', design: { variant: 'strip' } },
      { type: 'trust-strip' },
    ],
    name: { ar: 'سفرة العيلة', en: 'Family table' },
    forWhom: {
      ar: 'لمطبخ بيتي بياخد طلبات زي المطعم.',
      en: 'For a home kitchen taking same-day orders.',
    },
    idea: { ar: 'اطلب زي المنيو، مش زي المحل.', en: 'Order like a menu.' },
    tokens: {
      page: '#FFFFFF',
      // Ruling B4-2: the direction's terracotta (#B5482E, hue 12) is re-derived to pomegranate
      // clay, surface/line/ink follow it (hue 342-353), the herb green is darkened for text.
      surface: '#FBF1F2',
      ink: '#2B1A1F',
      muted: '#62505A',
      primary: '#A5303F',
      onPrimary: '#FFFFFF',
      // TEMPLATES-MOCK-9: the mock's herb green #3E7A3A (5.19:1 on the page), was #2F6B34.
      accent: '#3E7A3A',
      line: '#EBD6DA',
      fonts: { display: 'El Messiri', body: 'Cairo', latin: 'Fraunces' },
      radius: 'md',
      density: 'regular',
      imageRatio: '4/3',
      motion: 'subtle',
      cardBadge: 'accent',
    },
  }),
  L({
    id: 'lamma.notebook',
    template: 'lamma',
    letter: 'B',
    skin: 'lamma',
    status: 'built',
    chrome: {
      header: { logoPlacement: 'centre' },
      cartBar: 'total',
      cardStepper: 'inline',
      // Ruling B4-15: the listing pages stay on the green (no cream sheet); photos sit on a paper matte.
      listing: 'ground',
    },
    // Ruling B4-1 (Kitchen notebook). The cook is the brand: her photo and story lead, no hero. The
    // dish grid sits on the LIGHT band (`token:inverse`, quality bar section 9 rule 1) because the
    // merchant's dish photos are shot on white and would read as white rectangles on the green.
    sections: [
      { type: 'maker-profile', design: { variant: 'lead' } },
      {
        type: 'product-carousel',
        preset: {
          productSource: 'reorder',
          limit: 8,
          title: 'Order again',
          titleAr: 'اطلب تاني',
        },
      },
      {
        type: 'featured-collection',
        design: { columns: 2, mobileColumns: 2, bgColor: 'token:inverse' },
        preset: {
          productSource: 'newest',
          limit: 8,
          heading: 'From the kitchen today',
          headingAr: 'من المطبخ النهاردة',
        },
      },
      // T7: the template's signature section, after the main grid (filled by the merchant or the demo seed).
      { type: 'kitchen-days' },
      { type: 'brand-story' },
      { type: 'trust-strip' },
    ],
    name: { ar: 'كشكول المطبخ', en: 'Kitchen notebook' },
    forWhom: { ar: 'لطباخة واحدة اسمها هو البراند.', en: 'For one named cook who is the brand.' },
    idea: { ar: 'الطباخة هي البراند.', en: 'The cook is the brand.' },
    tokens: {
      page: '#1F3D2B',
      surface: '#29503A',
      ink: '#F5F7F2',
      muted: '#C3D3C8',
      // Ruling B4-2: the saffron (#E0A526) is re-derived to antique brass, the ONE metal of
      // Lamma (a scoped exception of the no-orange gate for exactly this hex on this look).
      primary: '#D3B87C',
      onPrimary: '#1F3D2B',
      accent: '#D3B87C',
      line: '#345E46',
      // Ruling B4-16: UI text is a Sans Arabic face (Naskh reads 8-9px at 12px); Aref Ruqaa stays the display.
      fonts: { display: 'Aref Ruqaa', body: 'Noto Sans Arabic', latin: 'Lora' },
      radius: 'sm',
      density: 'airy',
      imageRatio: '4/3',
      motion: 'subtle',
      cardBadge: 'accent',
      cardCta: 'quiet',
      overPhotoChrome: 'soft',
    },
  }),
  L({
    id: 'lamma.market',
    template: 'lamma',
    letter: 'C',
    skin: 'lamma',
    status: 'built',
    chrome: {
      header: { logoPlacement: 'start' },
      cartBar: 'total',
      cardStepper: 'inline',
      aisles: ['#23744A', '#CC2F3F', '#5B2A6E', '#0F7F8C'],
    },
    // Ruling B4-1 (Fresh market). Aisle tiles first (three across on a phone, so eight or more fit
    // the first screen), today's deals, then a dense two-across grid whose cards carry the stepper.
    sections: [
      {
        type: 'category-grid',
        design: {
          layout: 'tiles',
          layoutMobile: 'tiles',
          tint: 'aisles',
          mobileColumns: 3,
          captionPosition: 'below',
          paddingTop: 'tight',
          paddingBottom: 'none',
        },
      },
      {
        type: 'product-carousel',
        preset: {
          productSource: 'reorder',
          limit: 8,
          title: 'Order again',
          titleAr: 'اطلب تاني',
        },
      },
      {
        type: 'product-carousel',
        design: { paddingTop: 'tight' },
        preset: {
          productSource: 'on_sale',
          limit: 8,
          title: 'Deals today',
          titleAr: 'عروض النهاردة',
        },
      },
      {
        type: 'featured-collection',
        design: { columns: 4, mobileColumns: 2, paddingTop: 'tight' },
        preset: {
          productSource: 'newest',
          limit: 24,
          heading: 'Fresh today',
          headingAr: 'طازة النهاردة',
        },
      },
      // T7: the template's signature section, after the main grid (filled by the merchant or the demo seed).
      { type: 'kitchen-days' },
      { type: 'trust-strip' },
    ],
    name: { ar: 'سوق طازة', en: 'Fresh market' },
    forWhom: {
      ar: 'للبقالة والخضار اللي الطلب بيتكرر فيها.',
      en: 'For grocery with repeat baskets.',
    },
    idea: { ar: 'كل حاجة في ضغطتين.', en: 'Everything in two taps.' },
    tokens: {
      page: '#FFFFFF',
      surface: '#F4F4F4',
      ink: '#1B1B1B',
      muted: '#575757',
      primary: '#23744A',
      onPrimary: '#FFFFFF',
      // Ruling B4-2: the tomato (#C8361F, hue 8) is re-derived to crimson tomato.
      accent: '#CC2F3F',
      line: '#E4E4E4',
      fonts: { display: 'Baloo Bhaijaan 2', body: 'Almarai', latin: 'Nunito' },
      radius: 'lg',
      density: 'compact',
      imageRatio: '1/1',
      motion: 'expressive',
      cardBadge: 'accent',
    },
  }),
  L({
    id: 'dahab.worn',
    template: 'dahab',
    letter: 'A',
    skin: 'dahab',
    status: 'built',
    // Ruling B5-1 / B1-4: logo at the start, the skin's own icon search (jewellery is bought by eye).
    chrome: { header: { logoPlacement: 'start', search: 'icon' } },
    // Ruling B1-3 shape. Worn: the piece on a body, the size line under each name (karat and width
    // are the two fact chips, Ruling B5-5), engraving as one band that links to the personalised
    // piece. The chip row is navigation, so it sits right under the hero.
    sections: [
      { type: 'hero', design: { presentation: 'full-bleed' } },
      {
        type: 'category-grid',
        design: {
          layout: 'chips',
          layoutMobile: 'chips',
          paddingTop: 'tight',
          paddingBottom: 'none',
        },
      },
      {
        type: 'featured-collection',
        design: { columns: 4, mobileColumns: 2 },
        preset: {
          productSource: 'newest',
          limit: 8,
          heading: 'Worn every day',
          headingAr: 'بتتلبس كل يوم',
        },
      },
      // T7: the template's signature section, after the main grid (filled by the merchant or the demo seed).
      { type: 'piece-window' },
      {
        type: 'image-text',
        design: { layout: 'full-bleed', imagePosition: 'start', bgColor: 'token:card' },
        preset: {
          heading: 'Your name, engraved',
          headingAr: 'اسمك محفور عليها',
          body: 'Pick a piece, type the letters, and the workshop engraves them before it ships.',
          bodyAr: 'اختار القطعة واكتب الحروف، والورشة بتحفرها قبل ما تتشحن.',
          buttonText: 'Personalise',
          buttonTextAr: 'خصّص',
        },
      },
      {
        type: 'product-carousel',
        design: { paddingTop: 'tight', paddingBottom: 'tight' },
        preset: { productSource: 'newest', limit: 8, title: 'New in', titleAr: 'وصل حديثاً' },
      },
      { type: 'testimonials' },
      { type: 'brand-story' },
    ],
    name: { ar: 'على الإيد', en: 'Worn' },
    forWhom: {
      ar: 'لصايغ زباينه بيسألوا عن المقاس والعيار.',
      en: 'For a jeweller whose customers ask about size and karat.',
    },
    idea: { ar: 'متلبسة، مش معروضة: المقاس والعيار باينين دايمًا.', en: 'Worn, not displayed.' },
    tokens: {
      page: '#FFFFFF',
      surface: '#F6F6F6',
      ink: '#121212',
      muted: '#5A5A5A',
      primary: '#121212',
      onPrimary: '#FFFFFF',
      // Ruling B5-2: rose gold (hue 351), not the brass the first design used.
      // TEMPLATES-MOCK-9: the mock's gold #A9792E was NOT taken (see that ruling): at 4.5:1 on white it falls out of
      // the METAL-1 band (lightness < 0.4) and into the no-orange gate.
      accent: '#8F4F59',
      onAccent: '#FFFFFF',
      line: '#E8E8E8',
      fonts: { display: 'Reem Kufi', body: 'IBM Plex Sans Arabic', latin: 'Bodoni Moda' },
      radius: 'none',
      density: 'airy',
      imageRatio: '4/5',
      motion: 'subtle',
    },
  }),
  L({
    id: 'dahab.workshop',
    template: 'dahab',
    letter: 'B',
    skin: 'dahab',
    status: 'built',
    chrome: { header: { logoPlacement: 'start', search: 'icon' } },
    // Ruling B5-8: the journey of a piece (draw, cast, polish) reuses Jasmine's `steps` with the
    // mix's own three blocks. The page is committed teal, so the merchant-photo sections sit on a
    // light band (quality bar section 9 rule 1) and the CTA is silver.
    sections: [
      { type: 'hero', design: { presentation: 'full-bleed' } },
      {
        type: 'steps',
        preset: { heading: 'How a piece is made', headingAr: 'القطعة بتتعمل إزاي' },
        blocks: [
          {
            type: 'step',
            settings: {
              title: 'Drawn',
              titleAr: 'رسم',
              body: 'The shape is drawn by hand, then the wax is carved.',
              bodyAr: 'الشكل بيتحط على الورق بالإيد، وبعدين الشمع بيتنحت.',
            },
          },
          {
            type: 'step',
            settings: {
              title: 'Cast',
              titleAr: 'صب',
              body: 'The wax becomes silver in the mould, one piece at a time.',
              bodyAr: 'الشمع بيتحوّل فضة في القالب، قطعة قطعة.',
            },
          },
          {
            type: 'step',
            settings: {
              title: 'Polished',
              titleAr: 'تلميع',
              body: 'Filed, polished and checked before it is packed.',
              bodyAr: 'بتتبرد وتتلمّع وتتراجع قبل ما تتغلف.',
            },
          },
        ],
      },
      {
        type: 'featured-collection',
        design: { columns: 4, mobileColumns: 2, bgColor: 'token:inverse' },
        preset: {
          productSource: 'newest',
          limit: 8,
          heading: 'Made to order',
          headingAr: 'بتتعمل بالطلب',
        },
      },
      // T7: the template's signature section, after the main grid (filled by the merchant or the demo seed).
      { type: 'piece-window' },
      {
        type: 'image-text',
        design: { layout: 'split', imagePosition: 'end', imageAspect: 'landscape' },
        preset: {
          heading: 'Small workshop, real hands',
          headingAr: 'ورشة صغيرة وإيد حقيقية',
          body: 'Every piece is made in small batches, so a custom size is a normal request.',
          bodyAr: 'كل قطعة بتتعمل في دفعات صغيرة، فالمقاس المخصوص طلب عادي.',
        },
      },
      {
        type: 'collection-list',
        design: { tileShape: 'rectangle', columns: 4 },
        preset: { heading: 'Shop by collection', headingAr: 'تسوّق حسب المجموعة' },
      },
      { type: 'trust-badges' },
      { type: 'brand-story' },
    ],
    name: { ar: 'الورشة', en: 'Workshop' },
    forWhom: { ar: 'لورشة فضة يدوي الصنعة فيها هي السبب.', en: 'For a handmade silver studio.' },
    idea: { ar: 'الصنعة هي المنتج.', en: 'The making is the product.' },
    tokens: {
      page: '#0F4C4A',
      surface: '#135957',
      ink: '#FFFFFF',
      muted: '#CFE2E0',
      // Ruling B5-2: the CTA is silver with teal ink (the coral #E2674A failed the no-orange gate and
      // was 2.91:1 on the page); enamel is the accent, champagne draws the hairlines.
      primary: '#E4E7EB',
      onPrimary: '#0F4C4A',
      accent: '#9FD8CB',
      onAccent: '#0F4C4A',
      line: '#D8C9A8',
      fonts: { display: 'Markazi Text', body: 'Almarai', latin: 'Libre Caslon Text' },
      radius: 'sm',
      density: 'regular',
      imageRatio: '1/1',
      motion: 'subtle',
    },
  }),
  L({
    id: 'dahab.giftbox',
    template: 'dahab',
    letter: 'C',
    skin: 'dahab',
    status: 'built',
    chrome: { header: { logoPlacement: 'start', search: 'icon' } },
    // Ruling B5-4 / B5-7: start from who and how much. The gift finder sits right under the hero,
    // wrap and the card message are product options, the delivery promise is the computed chip.
    sections: [
      { type: 'hero', design: { presentation: 'full-bleed' } },
      { type: 'gift-finder', design: { bgColor: 'token:card' } },
      {
        type: 'featured-collection',
        design: { columns: 4, mobileColumns: 2 },
        preset: {
          productSource: 'newest',
          limit: 8,
          heading: 'Gifts she will keep',
          headingAr: 'هدايا هتفضل معاها',
        },
      },
      // T7: the template's signature section, after the main grid (filled by the merchant or the demo seed).
      { type: 'piece-window' },
      {
        type: 'image-text',
        design: { layout: 'full-bleed', imagePosition: 'end', bgColor: 'token:card' },
        preset: {
          heading: 'Wrapped to the front door',
          headingAr: 'بنغلّفها لحد باب الفرح',
          body: 'An emerald box, a satin ribbon and your own message on a card.',
          bodyAr: 'علبة زمردية وشريط ساتان ورسالتك على كارت.',
        },
      },
      {
        type: 'product-carousel',
        design: { paddingTop: 'tight', paddingBottom: 'tight' },
        preset: { productSource: 'newest', limit: 8, title: 'New in', titleAr: 'وصل حديثاً' },
      },
      { type: 'trust-badges' },
      { type: 'newsletter' },
    ],
    name: { ar: 'علبة هدية', en: 'Gift box' },
    forWhom: {
      ar: 'لمشتري الهدايا اللي بيبدأ بمين وبكام.',
      en: 'For gift buyers who start with who and how much.',
    },
    idea: { ar: 'تسوّق حسب الشخص والميزانية.', en: 'Shop by recipient and budget.' },
    tokens: {
      page: '#FFFFFF',
      surface: '#F2C9C4',
      ink: '#16201C',
      muted: '#4E5A54',
      primary: '#0E5C46',
      onPrimary: '#FFFFFF',
      // Ruling B5-2: the ribbon is rose gold; the first design's brass #7E5E27 is retired. Ruling B5-33: darkened from #8F4F59 (4.06:1 on the #F2C9C4 surface) to clear 4.5:1.
      accent: '#7A4049',
      onAccent: '#FFFFFF',
      line: '#E6E6E6',
      fonts: { display: 'Kufam', body: 'Tajawal', latin: 'Italiana' },
      radius: 'md',
      density: 'regular',
      imageRatio: '1/1',
      motion: 'subtle',
    },
  }),
];

export function getLook(id: string | null | undefined): LookDefinition | undefined {
  if (!id) return undefined;
  return LOOKS.find(l => l.id === id);
}
export function looksForTemplate(t: LookTemplate): LookDefinition[] {
  return LOOKS.filter(l => l.template === t);
}

/**
 * What a NEW store may be created on. Driven entirely by `status: 'built'` above: flipping a
 * look to 'built' makes its template appear in signup, onboarding and the admin switcher, and
 * makes its skin acceptable to the API, with no second list to edit. The five retired Force
 * skins (`RETIRED_TEMPLATES`) have no look, so they are never offered.
 */
export function builtLooks(): LookDefinition[] {
  return LOOKS.filter(l => l.status === 'built');
}
/** Templates with at least one built look, in registry order. */
export function builtLookTemplates(): LookTemplate[] {
  return LOOK_TEMPLATES.filter(t => LOOKS.some(l => l.template === t && l.status === 'built'));
}
/** The component skins a built look renders with (the only skins a new store may start on). */
export function builtSkins(): string[] {
  return [...new Set(builtLooks().map(l => l.skin as string))];
}
export function isBuiltSkin(skin: unknown): skin is LookDefinition['skin'] {
  return typeof skin === 'string' && builtSkins().includes(skin);
}
export function isBuiltLook(id: string | null | undefined): boolean {
  return getLook(id)?.status === 'built';
}
/** The look a new store gets when none is asked for: the first built look of the first built template. */
export function defaultNewStoreLook(): LookDefinition {
  const first = builtLookTemplates()[0];
  const look = first ? looksForTemplate(first).find(l => l.status === 'built') : undefined;
  if (!look)
    throw new Error('looks registry has no built look: a new store has nothing to start on');
  return look;
}
