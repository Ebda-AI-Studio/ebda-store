// READ-ONLY verification (spec §7/§11): assert the brand engine produces the
// 4 brand color/foreground pairs BYTE-IDENTICAL to wadyaljuz's stored theme.
// If any of the 8 vars differ, wadyaljuz would visually move — that is a fail.
//   run:  node packages/database/scripts/verify-wadyaljuz-brand-engine-nodrift.mjs
import { createPrismaClient } from '@force/database';
import { deriveBrandRoles } from '@force/shared';

const prisma = createPrismaClient({ connectionString: process.env.DATABASE_URL ?? '', role: 'owner' });

const PAIRS = [
  ['--primary', 'primaryColor', '--primary-foreground', 'primaryForeground'],
  ['--secondary', 'secondaryColor', '--secondary-foreground', 'secondaryForeground'],
  ['--accent', 'accentColor', '--accent-foreground', 'accentForeground'],
  ['--card', 'cardColor', '--card-foreground', 'cardForeground'],
];

const store = await prisma.store.findUnique({
  where: { slug: 'wady-aljuz' },
  select: { slug: true, theme: true },
});

if (!store) {
  console.error('FAIL: store wady-aljuz not found');
  process.exit(2);
}

const theme = store.theme ?? {};
const vars = deriveBrandRoles(theme);

let drift = 0;
for (const [colorVar, colorField, fgVar, fgField] of PAIRS) {
  const beforeColor = theme[colorField];
  const beforeFg = theme[fgField];
  const afterColor = vars[colorVar];
  const afterFg = vars[fgVar];
  // Color var: engine echoes the stored color verbatim (or omits if unset).
  if (beforeColor !== undefined && afterColor !== beforeColor) {
    console.error(`DRIFT ${colorVar}: stored="${beforeColor}" -> engine="${afterColor}"`);
    drift++;
  }
  // Foreground var: stored readable value MUST be preserved verbatim.
  if (beforeFg !== undefined && afterFg !== beforeFg) {
    console.error(
      `DRIFT ${fgVar}: stored="${beforeFg}" -> engine="${afterFg}" (surface ${colorField}="${beforeColor}")`
    );
    drift++;
  }
  console.log(
    `${colorVar}=${afterColor ?? '(unset)'}  ${fgVar}: stored=${beforeFg ?? '(unset)'} -> ${afterFg ?? '(unset)'}`
  );
}

await prisma.$disconnect();

if (drift > 0) {
  console.error(`\nFAIL: ${drift} brand var(s) drifted — wadyaljuz would move. DO NOT ship.`);
  process.exit(1);
}
console.log('\nPASS: all 8 brand vars byte-identical — wadyaljuz does not move.');
