// Detect variant-duplicate products in Wady Aljuz.
//
// v2: axis-aware. Each product has a "platonic base" (name with all
// axis tokens stripped) plus a set of axis values: form, grind,
// color, size, taste, origin, treatment. Two products are co-variants
// if they share the same base AND all axis values match except
// exactly ONE axis where they differ. We chain those pairs into
// groups via union-find.
//
// This catches clean cases — "كزبرة حب" vs "كزبرة ناعم" (form axis)
// and "ترمس مر" vs "ترمس حلو" (taste axis) — without forcing
// "فلفل اسود حب" and "فلفل ابيض ناعم" together (two axes differ).
//
// Multi-axis groups still get reported in a SEPARATE section so the
// merchant can decide whether they're a 2-D variant table or just
// distinct products.
import { readFileSync, writeFileSync } from 'fs';

const products = JSON.parse(readFileSync('/tmp/wady-products.json', 'utf8'));

// One axis = one canonical "kind of difference". Order matters only
// for display. Each entry maps Arabic surface forms to a canonical
// label that becomes the variant option name.
const AXES = {
  form: {
    label: 'الشكل',
    values: {
      حب: 'حب',
      حبوب: 'حب',
      ناعم: 'ناعم',
      خشن: 'خشن',
      مطحون: 'مطحون',
      بودرة: 'بودرة',
      باودر: 'بودرة',
      مفروم: 'مفروم',
      عيدان: 'عيدان',
      كامل: 'كامل',
      كاملة: 'كامل',
      'عيدان كاملة': 'عيدان',
    },
  },
  color: {
    label: 'اللون',
    values: {
      اسود: 'أسود',
      أسود: 'أسود',
      ابيض: 'أبيض',
      أبيض: 'أبيض',
      احمر: 'أحمر',
      أحمر: 'أحمر',
      اصفر: 'أصفر',
      أصفر: 'أصفر',
      اخضر: 'أخضر',
      أخضر: 'أخضر',
      ذهبي: 'ذهبي',
    },
  },
  size: {
    label: 'الحجم',
    values: {
      صغير: 'صغير',
      وسط: 'وسط',
      متوسط: 'وسط',
      كبير: 'كبير',
      إكسترا: 'إكسترا',
      اكسترا: 'إكسترا',
      مميز: 'مميز',
    },
  },
  taste: {
    label: 'الطعم',
    values: {
      مر: 'مر',
      حلو: 'حلو',
      حار: 'حار',
    },
  },
  origin: {
    label: 'المنشأ',
    values: {
      سوري: 'سوري',
      مصري: 'مصري',
      ايراني: 'إيراني',
      إيراني: 'إيراني',
      هندي: 'هندي',
      تركي: 'تركي',
      فلسطيني: 'فلسطيني',
      فلسطينية: 'فلسطيني',
      الفلسطيني: 'فلسطيني',
      الفلسطينية: 'فلسطيني',
      لبناني: 'لبناني',
    },
  },
  treatment: {
    label: 'المعالجة',
    values: {
      محمص: 'محمص',
      محمصة: 'محمص',
      مالح: 'مالح',
      مملح: 'مالح',
      'بدون ملح': 'بدون ملح',
      مدخن: 'مدخن',
      مدخنة: 'مدخن',
      مجفف: 'مجفف',
      مجففة: 'مجفف',
      مجففه: 'مجفف',
      يابس: 'يابس',
      يابسة: 'يابس',
      طازج: 'طازج',
      طازجة: 'طازج',
    },
  },
};

// Build a single token → (axis, canonical) lookup
const TOKEN_TO_AXIS = new Map();
for (const [axis, def] of Object.entries(AXES)) {
  for (const [surface, canonical] of Object.entries(def.values)) {
    TOKEN_TO_AXIS.set(surface, { axis, canonical });
  }
}

const TOKENS_SORTED = [...TOKEN_TO_AXIS.keys()].sort((a, b) => b.length - a.length);

// Numeric size like "500g" / "1 كغ"
const SIZE_REGEX =
  /(\d+\s*(?:g|gm|gr|gram|grams|kg|ك|كغ|جم|غم|غرام|مل|ml|l|ل|لتر|قطعة|قطع|عبوة|كيس|باكيت)\b)/giu;

function normalizeArabic(s) {
  return (s || '')
    .replace(/ـ/g, '')
    .replace(/[إأآا]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractAxes(name) {
  const norm = normalizeArabic(name);
  const found = {};
  let stripped = norm;
  for (const tok of TOKENS_SORTED) {
    const normTok = normalizeArabic(tok);
    const re = new RegExp(`(^|\\s)${normTok}(\\s|$)`, 'u');
    if (re.test(stripped)) {
      const { axis, canonical } = TOKEN_TO_AXIS.get(tok);
      // Only record the FIRST surface form on each axis — if both
      // "اسود" and "احمر" are in the same name we still want to flag
      // a color axis but the chosen canonical is whichever matched.
      if (!found[axis]) found[axis] = canonical;
      stripped = stripped.replace(re, ' ');
    }
  }
  stripped = stripped.replace(SIZE_REGEX, ' ').replace(/\s+/g, ' ').trim();
  return { base: stripped, axes: found, original: name };
}

const enriched = products.map(p => ({
  ...p,
  meta: extractAxes(p.nameAr || p.name),
}));

// Group products by their stripped base
const byBase = new Map();
for (const p of enriched) {
  const k = p.meta.base;
  if (!k) continue;
  if (!byBase.has(k)) byBase.set(k, []);
  byBase.get(k).push(p);
}

// Within each base group, build co-variant pairs (differ on exactly
// one axis), then union-find them into clusters.
function uf() {
  const parent = new Map();
  function find(x) {
    if (!parent.has(x)) parent.set(x, x);
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  }
  function union(a, b) {
    parent.set(find(a), find(b));
  }
  return { find, union, parent };
}

const groups = [];
const ungroupedMulti = []; // multi-axis siblings, reported separately

for (const [base, items] of byBase) {
  if (items.length < 2) continue;
  const { find, union } = uf();
  const ids = items.map(p => p.id);
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i].meta.axes;
      const b = items[j].meta.axes;
      const allAxes = new Set([...Object.keys(a), ...Object.keys(b)]);
      let differing = 0;
      for (const ax of allAxes) {
        if (a[ax] !== b[ax]) differing += 1;
      }
      if (differing === 1) union(items[i].id, items[j].id);
    }
  }
  // Bucket items by their union-find root
  const buckets = new Map();
  for (const id of ids) {
    const r = find(id);
    if (!buckets.has(r)) buckets.set(r, []);
    buckets.get(r).push(items.find(p => p.id === id));
  }
  for (const [, members] of buckets) {
    if (members.length < 2) continue;
    // Determine which axes vary inside this group. "Absence" of an
    // axis on one member is itself a distinct value — without that,
    // a pair like (ورق غار, ورق غار ناعم) reports zero varying axes
    // because only the second has a `form` axis at all, and the
    // straight set { 'ناعم' } looks size-1 even though it's varying
    // against the implicit "—" of the first member.
    const ABSENT = '__ABSENT__';
    const axisValues = {};
    const allAxesSeen = new Set();
    for (const m of members) for (const ax of Object.keys(m.meta.axes)) allAxesSeen.add(ax);
    for (const ax of allAxesSeen) {
      axisValues[ax] = new Set(members.map(m => m.meta.axes[ax] ?? ABSENT));
    }
    const varyingAxes = Object.entries(axisValues)
      .filter(([, vs]) => vs.size > 1)
      .map(([ax]) => ax);
    if (varyingAxes.length === 1) {
      groups.push({ base, axis: varyingAxes[0], products: members });
    } else {
      ungroupedMulti.push({ base, axes: varyingAxes, products: members });
    }
  }
}

groups.sort((a, b) => b.products.length - a.products.length);
ungroupedMulti.sort((a, b) => b.products.length - a.products.length);

// Markdown report
let md = `# Wady Aljuz — Variant-merge proposal (v2)\n\n`;
md += `${products.length} products → ${byBase.size} unique bases.\n`;
md += `**${groups.length} clean groups** (single-axis variants — safe to fold).\n`;
md += `**${ungroupedMulti.length} multi-axis groups** (need review — could be 2-D variant tables or distinct products).\n\n`;

md += `## Clean single-axis groups (safe to fold)\n\n`;
md += `Each group below has one parent product (kept) and the rest become \`ProductVariant\` rows. Historical \`OrderItem\` rows get rewritten so existing orders still resolve.\n\n`;
for (const g of groups) {
  md += `### \`${g.base}\` × ${g.products.length}  —  axis: **${AXES[g.axis].label}** (${g.axis})\n\n`;
  md += '| SKU | Name (Ar) | Axis value | Price | Stock |\n|---|---|---|---|---|\n';
  for (const p of g.products) {
    const price = (p.price / 1000).toFixed(3);
    const axisVal = p.meta.axes[g.axis] || '—';
    md += `| ${p.sku || '-'} | ${(p.nameAr || '').slice(0, 60)} | ${axisVal} | ${price} KWD | ${p.inventory} |\n`;
  }
  md += '\n';
}

md += `## Multi-axis groups (needs merchant review)\n\n`;
md += `These products share a base name but differ on more than one axis. They COULD be a 2-dimensional variant table (e.g. color × grind) or they could be genuinely distinct SKUs that happen to share a base word.\n\n`;
for (const g of ungroupedMulti) {
  md += `### \`${g.base}\` × ${g.products.length}  —  axes vary: ${g.axes.join(', ')}\n\n`;
  md +=
    '| SKU | Name (Ar) | ' +
    g.axes.map(a => AXES[a].label).join(' | ') +
    ' | Price |\n|---|---|' +
    g.axes.map(() => '---').join('|') +
    '|---|\n';
  for (const p of g.products) {
    const price = (p.price / 1000).toFixed(3);
    const axisCells = g.axes.map(a => p.meta.axes[a] || '—').join(' | ');
    md += `| ${p.sku || '-'} | ${(p.nameAr || '').slice(0, 60)} | ${axisCells} | ${price} KWD |\n`;
  }
  md += '\n';
}

writeFileSync('/tmp/wady-variant-groups.json', JSON.stringify({ groups, ungroupedMulti }, null, 2));
writeFileSync('/tmp/wady-variant-groups.md', md);

console.log(
  `Clean single-axis groups: ${groups.length} (${groups.reduce((s, g) => s + g.products.length, 0)} products)`
);
console.log(
  `Multi-axis groups (review): ${ungroupedMulti.length} (${ungroupedMulti.reduce((s, g) => s + g.products.length, 0)} products)`
);
console.log(`\nTop clean groups:`);
for (const g of groups.slice(0, 12)) {
  console.log(`  ${g.products.length}× ${g.base} (axis: ${g.axis})`);
}
console.log(`\nMulti-axis groups (need review):`);
for (const g of ungroupedMulti) {
  console.log(`  ${g.products.length}× ${g.base} (axes: ${g.axes.join(', ')})`);
}
console.log(`\nReview doc: /tmp/wady-variant-groups.md`);
