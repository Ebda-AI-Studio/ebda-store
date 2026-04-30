// Classify Wady Aljuz's 264 products into the new 7-bucket scheme.
// Best Sellers stays empty (user populates manually).
//
// Inputs:  /tmp/wady-categories.json + /tmp/wady-products.json
// Outputs: /tmp/wady-classification.json (proposal — apply only after review)
//          /tmp/wady-classification.md   (human-readable review doc)
import { readFileSync, writeFileSync } from 'fs';

const cats = JSON.parse(readFileSync('/tmp/wady-categories.json', 'utf8'));
const products = JSON.parse(readFileSync('/tmp/wady-products.json', 'utf8'));

const catById = new Map(cats.map(c => [c.id, c]));

// New target buckets — keys are slugs we'll create on the store.
const NEW_BUCKETS = {
  'best-sellers':         { name: 'Best Sellers',          nameAr: 'الأكثر مبيعاً',   position: 0, manual: true },
  'palestinian':          { name: 'Palestinian Products',  nameAr: 'المنتجات الفلسطينية', position: 1 },
  'legumes':              { name: 'Legumes',               nameAr: 'البقوليات',        position: 2 },
  'herbs-and-leafy':      { name: 'Herbs & Leafy',         nameAr: 'الاعشاب والورقيات', position: 3 },
  'spices':               { name: 'Spices',                nameAr: 'البهارات',         position: 4 },
  'nuts':                 { name: 'Nuts',                  nameAr: 'المكسرات',         position: 5 },
  'grains':               { name: 'Grains',                nameAr: 'الحبوب',           position: 6 },
  'healthy-mixes':        { name: 'Healthy Mixes',         nameAr: 'خلطات صحية',       position: 7 },
};

// Old-category-name → new-bucket-slug. Used when an Arabic keyword
// match isn't decisive — the merchant grouped most products correctly
// already, this just lets us trust their old buckets where the
// mapping is unambiguous.
const OLD_CAT_DEFAULT = {
  'بقوليات':       'legumes',
  'بهارات':         'spices',
  'خلطات بهار':     'spices',         // spice mixes still belong with spices
  'مكسرات':         'nuts',
  'حبوب':           'grains',
  'بذور':           'grains',         // seeds with grains (chia, flax, sesame)
  'اعشاب':          'herbs-and-leafy',
  'ورقيات':         'herbs-and-leafy',
  'فواكه مجففة':    'herbs-and-leafy', // dried fruits — closest fit
  'فواكه مجففه':    'herbs-and-leafy', // typo variant of the above
  'زيوت':           'palestinian',     // olive oil etc. — Palestinian heritage
  'تمور':           'palestinian',
};

// Arabic-keyword overrides applied AFTER the old-cat default so a
// `زعتر` in the spices bucket gets pulled into Palestinian.
const KEYWORD_RULES = [
  // Palestinian heritage produce + traditional household / cosmetic
  // items the merchant grouped under "أدوات" / "عناية" but are part of
  // the same heritage bundle as the food (Nabulsi soap, ma'amoul
  // molds, mate cups go alongside dates and olive oil for shoppers
  // looking for the "Palestinian/Levantine" basket).
  { match: /(زيت زيتون|زيتون|زيت ميرامية|دبس الخروب|دبس الرمان|دبس|سماق|زعتر|ميرمية|مريمية|ماء زهر|ماء ورد|مكدوس|لبنة|جبنة|تمر|تمور|قطين|تين|صابون نابلسي|دم الغزال|قوالب معمول|كاسات متة|مصاصات للمتة|كاسات للمتة|متة)/, bucket: 'palestinian' },
  // صمغ عربي (gum arabic) — used in cooking and as a thickener;
  // sits naturally in the spices bucket.
  { match: /(صمغ عربي)/, bucket: 'spices' },
  // Health / wellness mixes — names that read like compounded blends
  { match: /(خلطة النفاس|خلطة الرضع|خلطة طاقة|خلطة الحامل|خلطة شعر|خلطة بشرة|خلطة الأطفال|خلطة الام|خلطة المعدة|خلطة هضم|خلطة الكولسترول|خلطة السكري|خلطة الجنسنغ|خلطة العسل)/, bucket: 'healthy-mixes' },
  // Nuts that get mis-tagged
  { match: /(لوز|جوز|فستق|كاجو|بندق|صنوبر|طحين اللوز)/, bucket: 'nuts' },
  // Spice (single-ingredient or named blends)
  { match: /(فلفل|كمون|كركم|قرفة|زنجبيل|كزبرة|هيل|قرنفل|كاري|جوز الطيب|بابريكا|بسباس|سحلب|ينسون|شومر|حبة سوداء|كراوية|عين جرادة)/, bucket: 'spices' },
  // Grains / cereals
  { match: /(ارز|أرز|برغل|فريك|شوفان|قمح|دقيق|طحين|شعير|ذرة|كينوا|سميد|بليلة)/, bucket: 'grains' },
  // Legumes
  { match: /(فاصوليا|عدس|حمص|لوبيا|بازيلا|ترمس|فول|ماش|بازلا)/, bucket: 'legumes' },
  // Herbs & dried-leaf teas
  { match: /(بابونج|نعناع|شيح|ورق غار|إكليل|ميلسة|مردقوش|زوفا|اشواغندا|بقدونس|كركديه|مرامية)/, bucket: 'herbs-and-leafy' },
];

// Free-form un-classifiable old categories — products from these
// fall back to the closest semantic match by name. The proposal
// surfaces them so the merchant can sanity-check.
const HARD_FALLBACK = {
  'حلويات':        'palestinian',     // sweets often Palestinian (ma'amoul, halwa)
  'مونة':           'palestinian',     // pantry goods — Palestinian heritage
  'شراب':           'palestinian',     // syrups — قهوة عربية etc., heritage
  'نكهات':          'spices',          // synthetic flavors → spices bucket
  'الوان طعام':     'spices',          // food colors → spices bucket
  'لبان':           'spices',          // gum / mastic → spices
  'اكلات':          'palestinian',     // prepared foods → Palestinian
  'خضار':           'herbs-and-leafy',
  'بذور':           'grains',
  'ادوات':          null,              // tools — no bucket fits, flag
  'عناية':          null,              // beauty/care — no bucket fits, flag
  'Products':       null,              // empty default-cat
};

function classify(p) {
  const blob = `${p.nameAr || ''} ${p.name || ''}`.trim();
  // 1. Keyword override wins — handles مكدوس in old "مونة" → palestinian
  for (const rule of KEYWORD_RULES) {
    if (rule.match.test(blob)) return { bucket: rule.bucket, reason: `keyword: ${rule.match.source.split('|')[0].replace(/[(]/g, '')}…` };
  }
  // 2. Try old-category default
  for (const link of p.categories) {
    const oldCat = catById.get(link.categoryId);
    if (!oldCat) continue;
    const name = oldCat.nameAr || oldCat.name;
    if (OLD_CAT_DEFAULT[name]) return { bucket: OLD_CAT_DEFAULT[name], reason: `old-cat: ${name}` };
    if (HARD_FALLBACK[name] !== undefined) {
      return { bucket: HARD_FALLBACK[name], reason: `fallback: ${name}` };
    }
  }
  return { bucket: null, reason: 'unclassified' };
}

const proposal = [];
const counts = Object.fromEntries(Object.keys(NEW_BUCKETS).map(k => [k, 0]));
counts['UNCLASSIFIED'] = 0;

for (const p of products) {
  const c = classify(p);
  proposal.push({
    productId: p.id,
    name: p.name,
    nameAr: p.nameAr,
    sku: p.sku,
    oldCategoryIds: p.categories.map(x => x.categoryId),
    oldCategoryNames: p.categories
      .map(x => catById.get(x.categoryId))
      .filter(Boolean)
      .map(c => c.nameAr || c.name),
    newBucket: c.bucket,
    reason: c.reason,
  });
  counts[c.bucket || 'UNCLASSIFIED'] += 1;
}

writeFileSync('/tmp/wady-classification.json', JSON.stringify({ buckets: NEW_BUCKETS, proposal }, null, 2));

// Markdown report
let md = `# Wady Aljuz — Category re-bucket proposal\n\n`;
md += `Source: ${products.length} products in ${cats.length} legacy categories.\n`;
md += `Targets: ${Object.keys(NEW_BUCKETS).length} new buckets (best-sellers stays empty).\n\n`;
md += `## Proposal counts\n\n`;
for (const [k, v] of Object.entries(counts)) {
  const label = NEW_BUCKETS[k]?.nameAr || k;
  md += `  - ${label.padEnd(30)} ${v}\n`;
}
md += `\n## Per-bucket product list\n\n`;
for (const slug of [...Object.keys(NEW_BUCKETS), 'UNCLASSIFIED']) {
  const items = proposal.filter(p => (p.newBucket || 'UNCLASSIFIED') === slug);
  if (items.length === 0) continue;
  const label = NEW_BUCKETS[slug]?.nameAr || 'UNCLASSIFIED';
  md += `### ${label} (${items.length})\n\n`;
  md += '| SKU | Name | Old categories | Reason |\n|---|---|---|---|\n';
  for (const it of items) {
    const name = (it.nameAr || it.name || '').slice(0, 60);
    const oldCats = it.oldCategoryNames.join(', ');
    md += `| ${it.sku || '-'} | ${name} | ${oldCats} | ${it.reason} |\n`;
  }
  md += '\n';
}

writeFileSync('/tmp/wady-classification.md', md);

console.log('Counts:');
for (const [k, v] of Object.entries(counts)) {
  console.log(`  ${(NEW_BUCKETS[k]?.nameAr || k).padEnd(30)} ${v}`);
}
console.log('\nReport: /tmp/wady-classification.md');
console.log('JSON:   /tmp/wady-classification.json');
