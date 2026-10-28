import type { Locale } from './site';

type L = Record<Locale, string>;

/**
 * Third-party assets shipped on ebda.app and the attribution their licences ask for (Ruling MKT-12).
 * Shown on /credits (linked from every footer); the same facts are kept in public/demo/CREDITS.md and
 * tests/unit/marketing-model3d.test.ts fails when either side loses one of them. CC BY 4.0 requires
 * attribution "in any reasonable manner": a credits page linked from every page's footer is that.
 */
export interface ModelCredit {
  /** File under public/3d. */
  file: string;
  title: string;
  author: string;
  /** Where the original lives. */
  sourceUrl: string;
  sourceName: string;
  license: string;
  licenseUrl: string;
  /** What was changed (CC BY asks for the changes to be indicated). */
  changes: L;
  /** Where it appears on the site. */
  use: L;
  /** Triangle count of the shipped file (measured with gltf-transform inspect). */
  triangles: number;
}

export const MODEL_CREDITS: readonly ModelCredit[] = [
  {
    file: 'qamar-sneaker.glb',
    title: 'MaterialsVariantsShoe',
    author: 'Shopify',
    sourceUrl:
      'https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/MaterialsVariantsShoe',
    sourceName: 'Khronos glTF-Sample-Assets',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    changes: {
      ar: 'محسّن للويب: ضغط meshopt وصور WebP بحد أقصى 1024 بكسل. من غير أي تعديل تاني.',
      en: 'Optimised for the web: meshopt compression and WebP textures up to 1024 px. Nothing else changed.',
    },
    use: { ar: 'كوتشي قمر في قسم صفحة المنتج 3D', en: 'The Qamar sneaker in the 3D product page' },
    triangles: 20308,
  },
  {
    file: 'brass-diya-lantern.glb',
    title: 'Brass Diya Lantern',
    author: 'Bhargav Kubal',
    sourceUrl: 'https://polyhaven.com/a/brass_diya_lantern',
    sourceName: 'Poly Haven',
    license: 'CC0 1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    changes: {
      ar: 'اتشالت السلسلة المعلّقة، واتحسّن للويب (meshopt وWebP). CC0 مش بتطلب نسب، وبنذكرها تقديرًا.',
      en: 'Hanging chain removed; optimised for the web (meshopt, WebP). CC0 needs no attribution; it is given as a courtesy.',
    },
    use: { ar: 'فانوس سوق في قسم صفحة المنتج 3D', en: 'The Souq lantern in the 3D product page' },
    triangles: 8138,
  },
  {
    file: 'lamma-clay-pot.glb',
    title: 'Ceramic Pot',
    author: 'Aron Łyczek',
    sourceUrl: 'https://polyhaven.com/a/ceramic_pot',
    sourceName: 'Poly Haven',
    license: 'CC0 1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    changes: {
      ar: 'محسّن للويب (meshopt وصور WebP بحد أقصى 1024 بكسل). CC0 مش بتطلب نسب، وبنذكرها تقديرًا.',
      en: 'Optimised for the web (meshopt, WebP textures up to 1024 px). CC0 needs no attribution; it is given as a courtesy.',
    },
    use: {
      ar: 'حلة فخار لمّة في قسم صفحة المنتج 3D',
      en: 'The Lamma clay pot in the 3D product page',
    },
    triangles: 3540,
  },
  {
    file: 'jasmine-serum.glb',
    title: 'Jasmine serum bottle',
    author: 'Ebda AI Studio',
    sourceUrl: 'https://ebda.app',
    sourceName: 'Ebda AI Studio (modelled in code with three.js)',
    license: 'CC0 1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    changes: {
      ar: 'موديل من تصميمنا بالكود، مش مأخوذ من حد. محسّن للويب (meshopt). CC0 مش بتطلب نسب.',
      en: 'Modelled by us in code, not taken from anyone. Optimised for the web (meshopt). CC0 needs no attribution.',
    },
    use: {
      ar: 'زجاجة سيروم ياسمين في قسم صفحة المنتج 3D',
      en: 'The Jasmine serum bottle in the 3D product page',
    },
    triangles: 3936,
  },
  {
    file: 'dahab-solitaire.glb',
    title: 'Dahab solitaire ring',
    author: 'Ebda AI Studio',
    sourceUrl: 'https://ebda.app',
    sourceName: 'Ebda AI Studio (modelled in code with three.js)',
    license: 'CC0 1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    changes: {
      ar: 'موديل من تصميمنا بالكود، مش مأخوذ من حد. محسّن للويب (meshopt). CC0 مش بتطلب نسب.',
      en: 'Modelled by us in code, not taken from anyone. Optimised for the web (meshopt). CC0 needs no attribution.',
    },
    use: {
      ar: 'خاتم سوليتير دهب في قسم صفحة المنتج 3D',
      en: 'The Dahab solitaire ring in the 3D product page',
    },
    triangles: 6616,
  },
];
