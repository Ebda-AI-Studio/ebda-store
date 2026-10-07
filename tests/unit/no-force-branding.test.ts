/**
 * Ebda is Ebda AI Studio's product. No inherited third-party brand, tenant, domain
 * or payment-provider string may survive in anything that runs or that a
 * user / merchant / shopper can see: app source, public assets, shipped
 * content (help/docs MDX), package source and the CI workflows.
 *
 * Scope: text files under apps/<app>/src, apps/<app>/public,
 * apps/<app>/content, packages/<pkg>/src and .github/workflows.
 * NOT scanned: docs/, tests/, scripts/, migrations (immutable history).
 *
 * PHASE_B_PENDING lists files another workstream owned while this guard
 * landed (builder/templates, billing/signup/onboarding/provisioning, tax) or
 * that carry an external wire contract. Every entry must still violate (the
 * last test), so the list can only shrink. Empty it in Phase B.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

const FORBIDDEN =
  /force-ai\.co|forcemedia|force media|force ai|forceai|force-website-builder|pecannbee|wadyaljuz|palora|\bKWD\b|MyFatoorah|Hesabe|UPayments|\bKNET\b/i;
// "FWB" without the false positives of a case-insensitive substring match:
// FWB, fwb_x, fwb-x, fwb.x, fwbStoreId — but not a run of letters containing it.
const FWB = /(?<![A-Za-z])(?:FWB|fwb)(?![a-z])|fwb[A-Z]/;

export function violates(line: string): boolean {
  return FORBIDDEN.test(line) || FWB.test(line);
}

/** repo-relative path -> why it may still carry a hit (Phase B). */
const PHASE_B_PENDING: Record<string, string> = {
  'apps/admin/src/app/stores/[id]/page-builder/page.tsx':
    'builder/templates/layout workstream (excluded)',
  'apps/admin/src/components/onboarding/PublicShell.tsx':
    'billing/plan/onboarding/provisioning workstream (excluded)',
  'apps/admin/src/i18n/messages/ar.json':
    'forceMediaAlt key still read by excluded onboarding/PublicShell.tsx',
  'apps/admin/src/i18n/messages/en.json':
    'forceMediaAlt key still read by excluded onboarding/PublicShell.tsx',
  'apps/api/src/lib/inngest/functions/order-whatsapp-notify.ts':
    'WBS bridge wire contract (fwbStoreId / fwbOrderId / wa_carts columns) - needs WBS-side decision',
  'apps/api/src/routes/store-layout.routes.ts': 'builder/templates/layout workstream (excluded)',
  'apps/api/src/routes/wa-bridge.routes.ts':
    'WBS bridge wire contract (fwbStoreId / fwbOrderId / wa_carts columns) - needs WBS-side decision',
  'apps/api/src/routes/wa-templates.routes.ts':
    'WBS bridge wire contract (fwbStoreId / fwbOrderId / wa_carts columns) - needs WBS-side decision',
  'apps/api/src/routes/wbs-integration.routes.ts':
    'WBS bridge wire contract (fwbStoreId / fwbOrderId / wa_carts columns) - needs WBS-side decision',
  'apps/api/src/services/abandoned-cart.service.ts':
    'WBS bridge wire contract (fwbStoreId / fwbOrderId / wa_carts columns) - needs WBS-side decision',
  'apps/api/src/services/meta-provisioner.service.ts':
    'billing/plan/onboarding/provisioning workstream (excluded)',
  'apps/api/src/services/plan-entitlements.ts':
    'billing/plan/onboarding/provisioning workstream (excluded)',
  'apps/api/src/services/plan-sync.ts':
    'billing/plan/onboarding/provisioning workstream (excluded)',
  'apps/api/src/services/recommendation.service.ts':
    'PecannbeeProductCard rename (blocked on templates workstream)',
  'apps/api/src/services/wbs-bridge.service.ts':
    'WBS bridge wire contract (fwbStoreId / fwbOrderId / wa_carts columns) - needs WBS-side decision',
  'apps/web/src/app/bundles/BundleCard.tsx':
    'PecannbeeProductCard rename (blocked on templates workstream)',
  'apps/web/src/app/layout.tsx': 'builder/templates/layout workstream (excluded)',
  'apps/web/src/app/products/ProductsClient.tsx':
    'PecannbeeProductCard rename (blocked on templates workstream)',
  'apps/web/src/app/tenant-store/[tenant]/[locale]/layout.tsx':
    'builder/templates/layout workstream (excluded)',
  'apps/web/src/builder/sections/FeaturedCollectionSection.tsx':
    'PecannbeeProductCard rename (blocked on templates workstream)',
  'apps/web/src/components/FrequentlyBoughtTogether.tsx':
    'PecannbeeProductCard rename (blocked on templates workstream)',
  'apps/web/src/components/YouMightAlsoLike.tsx':
    'PecannbeeProductCard rename (blocked on templates workstream)',
  'apps/web/src/lib/product-pricing.ts':
    'PecannbeeProductCard rename (blocked on templates workstream)',
  'apps/web/src/lib/serverTemplate.ts': 'builder/templates/layout workstream (excluded)',
  'apps/web/src/templates/bold/Header.tsx': 'builder/templates/layout workstream (excluded)',
  'apps/web/src/templates/bold/index.ts': 'builder/templates/layout workstream (excluded)',
  'apps/web/src/templates/classic/Header.tsx': 'builder/templates/layout workstream (excluded)',
  'apps/web/src/templates/classic/index.ts': 'builder/templates/layout workstream (excluded)',
  'apps/web/src/templates/elegant/Header.tsx': 'builder/templates/layout workstream (excluded)',
  'apps/web/src/templates/elegant/index.ts': 'builder/templates/layout workstream (excluded)',
  'apps/web/src/templates/minimal/Header.tsx': 'builder/templates/layout workstream (excluded)',
  'apps/web/src/templates/minimal/Hero.tsx': 'builder/templates/layout workstream (excluded)',
  'apps/web/src/templates/minimal/index.ts': 'builder/templates/layout workstream (excluded)',
  'apps/web/src/templates/modern/Header.tsx': 'builder/templates/layout workstream (excluded)',
  'apps/web/src/templates/modern/index.ts': 'builder/templates/layout workstream (excluded)',
  'apps/web/src/templates/modern/ProductCard.tsx': 'builder/templates/layout workstream (excluded)',
  'apps/web/src/templates/shared/BottomTabBar.tsx':
    'builder/templates/layout workstream (excluded)',
  'apps/web/src/templates/shared/card-size.ts': 'builder/templates/layout workstream (excluded)',
  'apps/web/src/templates/shared/CategoryStrip.tsx':
    'builder/templates/layout workstream (excluded)',
  'apps/web/src/templates/shared/custom-badge.ts': 'builder/templates/layout workstream (excluded)',
  'apps/web/src/templates/shared/FloatingWidget.tsx':
    'builder/templates/layout workstream (excluded)',
  'apps/web/src/templates/shared/footer-branches-render.test.tsx':
    'builder/templates/layout workstream (excluded)',
  'apps/web/src/templates/shared/HeroSlider.tsx': 'builder/templates/layout workstream (excluded)',
  'apps/web/src/templates/shared/oos-badge-collision.test.tsx':
    'builder/templates/layout workstream (excluded)',
  'apps/web/src/templates/shared/pack-styles.ts': 'builder/templates/layout workstream (excluded)',
  'apps/web/src/templates/shared/PecannbeeProductCard.tsx':
    'builder/templates/layout workstream (excluded)',
  'apps/web/src/templates/shared/product-card-badge-render.test.tsx':
    'builder/templates/layout workstream (excluded)',
  'apps/web/src/templates/shared/product-card-defaults.ts':
    'builder/templates/layout workstream (excluded)',
  'apps/web/src/templates/shared/ProductCardCta.tsx':
    'builder/templates/layout workstream (excluded)',
  'apps/web/src/templates/shared/ProductCarousel.tsx':
    'builder/templates/layout workstream (excluded)',
  'apps/web/src/templates/shared/section-typography.ts':
    'builder/templates/layout workstream (excluded)',
  'apps/web/src/templates/shared/SectionDivider.tsx':
    'builder/templates/layout workstream (excluded)',
  'apps/web/src/templates/shared/SectionHeading.tsx':
    'builder/templates/layout workstream (excluded)',
  'apps/web/src/templates/shared/ShareProductRow.tsx':
    'builder/templates/layout workstream (excluded)',
  'apps/web/src/templates/shared/SpecTable.tsx': 'builder/templates/layout workstream (excluded)',
  'apps/web/src/templates/shared/TrustStrip.tsx': 'builder/templates/layout workstream (excluded)',
  'packages/shared/src/order-tax.ts': 'tax/VAT workstream (excluded)',
  'packages/shared/src/schemas/plan-limits.ts':
    'billing/plan/onboarding/provisioning workstream (excluded)',
  'packages/shared/src/types/store-layout.ts': 'builder/templates/layout workstream (excluded)',
};

const SKIP_DIRS = new Set(['node_modules', '.next', '.open-next', 'dist', '.turbo', 'coverage']);
const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.jsonc', '.css', '.scss',
  '.html', '.svg', '.md', '.mdx', '.txt', '.webmanifest', '.xml', '.yml', '.yaml', '.sql', '.prisma',
]); // prettier-ignore

function roots(): string[] {
  const out: string[] = [path.join(ROOT, '.github/workflows')];
  for (const group of ['apps', 'packages']) {
    const dir = path.join(ROOT, group);
    for (const name of readdirSync(dir)) {
      const subs = group === 'apps' ? ['src', 'public', 'content'] : ['src'];
      for (const sub of subs) {
        const p = path.join(dir, name, sub);
        try {
          if (statSync(p).isDirectory()) out.push(p);
        } catch {
          /* app without that dir */
        }
      }
    }
  }
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), acc);
    } else if (TEXT_EXT.has(path.extname(entry.name).toLowerCase())) {
      acc.push(path.join(dir, entry.name));
    }
  }
  return acc;
}

const files = roots().flatMap(r => walk(r));
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join('/');

describe('no inherited third-party branding in shipped sources', () => {
  it('actually scans the app, package and workflow sources (not an empty-set pass)', () => {
    expect(files.length).toBeGreaterThan(1000);
    expect(files.some(f => rel(f).startsWith('apps/admin/public/'))).toBe(true);
    expect(files.some(f => rel(f) === 'packages/shared/src/brand/index.ts')).toBe(true);
    expect(files.some(f => rel(f) === '.github/workflows/ci.yml')).toBe(true);
  });

  it('the patterns catch each forbidden form and spare Ebda strings', () => {
    for (const s of [
      'Force AI', 'ForceAI-KW', 'x.force-ai.co', 'a.forcemediakw.com', 'force media', 'Force Media',
      'force-website-builder', 'pecannbee.com.kw', 'Wadyaljuz', 'palora', 'KWD', 'kwd',
      'MyFatoorah', 'hesabe', 'UPayments', 'KNET', 'FWB', 'fwb_store_id', 'fwb-eu', 'fwbStoreId',
    ]) {
      expect(violates(s), s).toBe(true);
    } // prettier-ignore
    for (const s of ['Ebda by Ebda AI Studio', 'EGP', 'Paymob', 'InstaPay', 'afwbc', 'KWDX']) {
      expect(violates(s), s).toBe(false);
    }
  });

  it('no file names an inherited brand, tenant, domain or payment provider', () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (rel(f) in PHASE_B_PENDING) continue;
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (violates(line)) offenders.push(`${rel(f)}:${i + 1}: ${line.trim().slice(0, 100)}`);
        });
    }
    expect(
      offenders,
      'Inherited branding found. Use BRAND from @force/shared (packages/shared/src/brand) and neutral demo data (EGP, +20).'
    ).toEqual([]);
  });

  it('every pending entry still exists and still violates (the list only shrinks)', () => {
    for (const file of Object.keys(PHASE_B_PENDING)) {
      const src = readFileSync(path.join(ROOT, file), 'utf8');
      expect(
        src.split('\n').some(violates),
        `${file} is clean now — drop it from PHASE_B_PENDING`
      ).toBe(true);
    }
  });
});
