'use client';

/**
 * Per-section typography override block (a section's heading / kicker / subtitle / ... roles, each a
 * `ZoneOverride`). Shared by the form page builder and the visual editor's settings panel; the roles a
 * section offers are chosen by the caller.
 */
import type { ColorToken, SectionTypographyOverride, StoreTheme, ZoneOverride } from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { ZoneEditor } from '../ZoneEditor';

/**
 * All supported per-section typography roles — extended 2026-05-19 (Wave 3A)
 * to cover product-card and category-card zones so section cards can host all
 * section-specific roles without merchants needing to scroll to the global card.
 */
export type SectionTypographyRole =
  | 'heading'
  | 'kicker'
  | 'subtitle'
  | 'seeAll'
  | 'productName'
  | 'productPrice'
  | 'productCta'
  | 'categoryLabel';

/**
 * Maps each per-section typography role to the brand token it inherits from
 * by default when no color is explicitly set. Used to populate the inherited
 * brand-color hint in the ZoneEditor ColorField empty state.
 */
export const ROLE_INHERIT: Record<SectionTypographyRole, ColorToken> = {
  heading: 'foreground',
  kicker: 'foreground',
  subtitle: 'foreground',
  seeAll: 'primary',
  productName: 'foreground',
  productPrice: 'foreground',
  productCta: 'primary',
  categoryLabel: 'foreground',
};

// Human-readable label for each per-section typography role — translated
// inline via t(`roleLabels.${role}`) at the single call site below.

/**
 * Maps each per-section role to the corresponding global typography zone key.
 * Used as placeholder hints in the ZoneEditor so the merchant sees what they'd
 * inherit from the global settings before setting a per-section override.
 */
export const ROLE_TO_GLOBAL_ZONE: Record<SectionTypographyRole, string> = {
  heading: 'sectionTitle',
  kicker: 'sectionKicker',
  subtitle: 'sectionSubtitle',
  seeAll: 'sectionSeeAll',
  productName: 'productName',
  productPrice: 'productPrice',
  productCta: 'cta',
  categoryLabel: 'categories',
};

/**
 * Per-section typography override block. Rendered at the bottom of each
 * SectionCard for sections that have heading / kicker / subtitle roles.
 * Each role maps to a `ZoneOverride` in `layout.<section>.typography`.
 *
 * The `globalZones` prop provides the corresponding global-zone values as
 * placeholder hints — so the merchant can see what they'd inherit from the
 * "Default typography" card below without needing to scroll there.
 */
export function SectionTypographyBlock({
  roles,
  typography,
  globalZones,
  onChangeRole,
  onResetRole,
  theme,
}: {
  roles: ReadonlyArray<SectionTypographyRole>;
  typography: SectionTypographyOverride | undefined;
  /** Global zone values used as placeholder hints in each ZoneEditor. */
  globalZones: Partial<Record<SectionTypographyRole, ZoneOverride>>;
  onChangeRole: (role: SectionTypographyRole, next: Partial<ZoneOverride>) => void;
  onResetRole: (role: SectionTypographyRole) => void;
  theme: StoreTheme | undefined;
}) {
  const t = useT('orders.layout');
  return (
    <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3">
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {t('typography.sectionOverrideTitle')}
      </h4>
      <p className="mb-3 text-xs text-muted-foreground/80">{t('typography.sectionOverrideHint')}</p>
      <div className="space-y-3">
        {roles.map(role => (
          <ZoneEditor
            key={role}
            zoneKey={`section.typography.${role}`}
            zoneLabel={t(`roleLabels.${role}`)}
            values={typography?.[role] ?? {}}
            placeholder={globalZones[role]}
            onChange={next => onChangeRole(role, next)}
            onReset={() => onResetRole(role)}
            theme={theme}
            inheritFromToken={ROLE_INHERIT[role]}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Legacy color-format normalization
// ---------------------------------------------------------------------------
// The old standalone /typography page stored tokens as 'brand-primary',
// 'brand-secondary', 'brand-accent'. The new ColorField emits 'token:primary',
// 'token:secondary', 'token:accent'. Normalise on load so the Default-typography
// card shows the correct Primary/Secondary/Accent chip instead of "Custom hex…".
function normalizeLegacyColor(value: string | undefined): string | undefined {
  if (!value) return value;
  if (value === 'brand-primary') return 'token:primary';
  if (value === 'brand-secondary') return 'token:secondary';
  if (value === 'brand-accent') return 'token:accent';
  return value;
}

export function normalizeZoneColors(zone: ZoneOverride): ZoneOverride {
  if (!zone.color) return zone;
  const normalized = normalizeLegacyColor(zone.color);
  return normalized === zone.color ? zone : { ...zone, color: normalized };
}
