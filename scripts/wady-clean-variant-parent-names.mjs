// Strip variant axis tokens from parent product display names so the
// admin / storefront card shows the generic base ("عين جرادة")
// instead of one of the variant labels ("عين جرادة ناعم").
//
// Reads:  /tmp/wady-variant-groups.json (the same proposal we already
//         applied — gives us each parent's id + its axis + the
//         canonical base string).
// Writes: parent.name + parent.nameAr to the base string.
//
// Dry-run by default; pass `--apply`.
import { prisma } from '@force/database';
import { readFileSync } from 'fs';

const APPLY = process.argv.includes('--apply');

const { groups } = JSON.parse(readFileSync('/tmp/wady-variant-groups.json', 'utf8'));

function skuRank(sku) {
  if (!sku) return Number.POSITIVE_INFINITY;
  const m = String(sku).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : Number.POSITIVE_INFINITY;
}

// Display-friendly Arabic base — re-normalise the unicode forms the
// classifier had to flatten (ا/ة/ي) so the user-visible name reads
// naturally. The classifier base lives in `g.base` already
// flattened; we go from that back to the merchant's preferred forms
// by reading the parent's original name and stripping just the axis
// token.
const AXIS_VALUES = {
  form: [
    'حب',
    'حبوب',
    'ناعم',
    'خشن',
    'مطحون',
    'بودرة',
    'باودر',
    'مفروم',
    'عيدان',
    'كامل',
    'كاملة',
    'عيدان كاملة',
  ],
  color: ['اسود', 'أسود', 'ابيض', 'أبيض', 'احمر', 'أحمر', 'اصفر', 'أصفر', 'اخضر', 'أخضر', 'ذهبي'],
  size: ['صغير', 'وسط', 'متوسط', 'كبير', 'إكسترا', 'اكسترا', 'مميز'],
  taste: ['مر', 'حلو', 'حار'],
  origin: [
    'سوري',
    'مصري',
    'ايراني',
    'إيراني',
    'هندي',
    'تركي',
    'فلسطيني',
    'فلسطينية',
    'الفلسطيني',
    'الفلسطينية',
    'لبناني',
  ],
  treatment: [
    'محمص',
    'محمصة',
    'مالح',
    'مملح',
    'بدون ملح',
    'مدخن',
    'مدخنة',
    'مجفف',
    'مجففة',
    'مجففه',
    'يابس',
    'يابسة',
    'طازج',
    'طازجة',
  ],
};

// English equivalents — strip these from machine-translated `name`
// fields so a parent labelled "Soft cumin" / "Premium Indian chopsticks"
// settles back to "cumin" / "Indian" instead of carrying a variant
// label into the storefront card.
const AXIS_VALUES_EN = {
  form: [
    'fine',
    'soft',
    'coarse',
    'ground',
    'whole',
    'powder',
    'powdered',
    'sticks',
    'chopsticks',
    'minced',
  ],
  color: ['black', 'white', 'red', 'yellow', 'green', 'golden'],
  size: ['small', 'medium', 'large', 'extra', 'premium'],
  taste: ['sweet', 'bitter', 'hot'],
  origin: ['syrian', 'egyptian', 'iranian', 'indian', 'turkish', 'palestinian', 'lebanese'],
  treatment: ['roasted', 'salted', 'unsalted', 'smoked', 'dried', 'dry', 'fresh'],
};

function stripAxisTokens(name, axis, tokens) {
  if (!name) return name;
  let s = name;
  for (const t of tokens) {
    // Word-boundary stripping. Arabic doesn't honour \b but \b works
    // for ASCII; use the looser whitespace-or-edge anchor for both.
    const re = new RegExp(`(^|\\s)${t}(\\s|$)`, 'giu');
    s = s.replace(re, ' ');
  }
  return s.replace(/\s+/g, ' ').trim();
}

let updated = 0;
let skipped = 0;
for (const g of groups) {
  // Skip the duplicate-axis-value group — it didn't get applied so
  // its parent is just an isolated product with the original name.
  const axisValues = new Map();
  for (const p of g.products) {
    const v = p.meta?.axes?.[g.axis];
    if (v) axisValues.set(v, (axisValues.get(v) || 0) + 1);
  }
  const hasCollision = [...axisValues.values()].some(n => n > 1);
  if (hasCollision) {
    skipped += 1;
    continue;
  }

  const parent = [...g.products].sort((a, b) => skuRank(a.sku) - skuRank(b.sku))[0];
  const cleanedAr = stripAxisTokens(parent.nameAr ?? '', g.axis, AXIS_VALUES[g.axis] || []);
  const cleanedEn = stripAxisTokens(parent.name ?? '', g.axis, AXIS_VALUES_EN[g.axis] || []);
  if (
    (cleanedAr === (parent.nameAr ?? '') || !cleanedAr) &&
    (cleanedEn === (parent.name ?? '') || !cleanedEn)
  ) {
    continue; // nothing to clean (name didn't contain a stripped token)
  }
  console.log(
    `  ${parent.sku?.padEnd(8) || '-'}  "${parent.nameAr}" → "${cleanedAr}"   |  "${parent.name}" → "${cleanedEn}"`
  );
  if (APPLY) {
    await prisma.product.update({
      where: { id: parent.id },
      data: {
        ...(cleanedAr && cleanedAr !== parent.nameAr ? { nameAr: cleanedAr } : {}),
        ...(cleanedEn && cleanedEn !== parent.name ? { name: cleanedEn } : {}),
      },
    });
  }
  updated += 1;
}

console.log(
  `\n${APPLY ? 'Updated' : 'Would update'} ${updated} parent name(s); skipped ${skipped} group(s).`
);
await prisma.$disconnect();
if (!APPLY) console.log('\nDRY RUN — pass --apply to write.');
