'use client';

/**
 * A section's `typography` setting in the visual editor: per-role font overrides (heading, kicker,
 * subtitle, ...) with the store's global zones as the "inherits" hint. It is the form page builder's
 * `SectionTypographyBlock` over the document, so the value written is the same `typography` object
 * the layout stores (no migration; an absent value means no override). Every edit is a draft edit.
 */
import { useEffect, useState } from 'react';
import type { SectionTypographyOverride, StoreTheme, ZoneOverride } from '@ebda/shared';
import {
  ROLE_TO_GLOBAL_ZONE,
  SectionTypographyBlock,
  normalizeZoneColors,
  type SectionTypographyRole,
} from '../../../../../components/section-design/SectionTypographyBlock';
import { apiGet } from '../../../../../lib/api';

/** The roles a section type offers (what its renderer reads). Anything else gets the heading only. */
const ROLES_BY_TYPE: Record<string, readonly SectionTypographyRole[]> = {
  hero: ['heading'],
  'category-grid': ['heading', 'kicker', 'subtitle', 'seeAll', 'categoryLabel'],
  'new-arrivals': [
    'heading',
    'kicker',
    'subtitle',
    'seeAll',
    'productName',
    'productPrice',
    'productCta',
  ],
  'best-sellers': [
    'heading',
    'kicker',
    'subtitle',
    'seeAll',
    'productName',
    'productPrice',
    'productCta',
  ],
  testimonials: ['heading', 'kicker', 'subtitle'],
  'featured-collection': ['heading', 'kicker', 'subtitle'],
  'product-carousel': [
    'heading',
    'kicker',
    'subtitle',
    'seeAll',
    'productName',
    'productPrice',
    'productCta',
  ],
};

export const typographyRolesFor = (sectionType: string): readonly SectionTypographyRole[] =>
  ROLES_BY_TYPE[sectionType] ?? ['heading'];

/** The next `typography` value after editing one role; undefined when no role is left. */
export function nextTypography(
  current: SectionTypographyOverride | undefined,
  role: SectionTypographyRole,
  patch: Partial<ZoneOverride> | null
): SectionTypographyOverride | undefined {
  const rest = { ...(current ?? {}) } as SectionTypographyOverride;
  if (patch === null) delete rest[role as keyof SectionTypographyOverride];
  else
    (rest as Record<string, ZoneOverride>)[role] = {
      ...((current as Record<string, ZoneOverride> | undefined)?.[role] ?? {}),
      ...patch,
    };
  return Object.keys(rest).length ? rest : undefined;
}

export function SectionTypographyField({
  storeId,
  sectionType,
  value,
  theme,
  onChange,
}: {
  storeId: string;
  sectionType: string;
  value: SectionTypographyOverride | undefined;
  theme: StoreTheme | undefined;
  onChange: (next: SectionTypographyOverride | undefined) => void;
}) {
  const [zones, setZones] = useState<Record<string, ZoneOverride>>({});
  useEffect(() => {
    let live = true;
    void apiGet<{ typography?: { zones?: Record<string, ZoneOverride> } }>(
      `/api/v1/stores/${storeId}/typography`
    ).then(r => {
      const raw = r.data?.typography?.zones;
      if (live && raw)
        setZones(
          Object.fromEntries(Object.entries(raw).map(([k, z]) => [k, normalizeZoneColors(z)]))
        );
    });
    return () => {
      live = false;
    };
  }, [storeId]);

  const roles = typographyRolesFor(sectionType);
  return (
    <div data-testid="section-typography-field">
      <SectionTypographyBlock
        roles={roles}
        typography={value}
        globalZones={Object.fromEntries(roles.map(r => [r, zones[ROLE_TO_GLOBAL_ZONE[r]]]))}
        onChangeRole={(role, next) => onChange(nextTypography(value, role, next))}
        onResetRole={role => onChange(nextTypography(value, role, null))}
        theme={theme}
      />
    </div>
  );
}
