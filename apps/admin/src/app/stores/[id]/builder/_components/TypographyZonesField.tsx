'use client';

/**
 * Global typography zones in the theme pane: one `ZoneEditor` per zone (header, section titles, product
 * names, ...), the same editors the page builder uses. A zone edit is a DRAFT edit
 * (`PageDefinition.typography.zones[zone]`); resetting a zone writes `null`, which clears it at
 * Publish (Ruling VE-4). `zones` is the effective set (live + draft).
 */
import type { StoreTheme, ZoneOverride } from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { ZoneEditor } from '../../../../../components/ZoneEditor';

/** Top to bottom of the storefront, like the page itself. */
export const ZONE_ORDER = [
  'beforeHeader',
  'header',
  'storeName',
  'sectionKicker',
  'sectionTitle',
  'sectionSubtitle',
  'sectionSeeAll',
  'categories',
  'products',
  'productName',
  'productPrice',
  'cta',
  'filters',
  'footer',
  'afterFooter',
] as const;

export function TypographyZonesField({
  zones,
  theme,
  onChange,
  onReset,
}: {
  zones: Record<string, ZoneOverride | undefined>;
  theme: StoreTheme | undefined;
  /** A partial edit of one zone; the caller merges it over the zone's current value. */
  onChange: (zone: string, next: Partial<ZoneOverride>) => void;
  onReset: (zone: string) => void;
}) {
  const t = useT('orders.layout');
  return (
    <div className="space-y-3" data-testid="typography-zones-field">
      {ZONE_ORDER.map(zone => (
        <ZoneEditor
          key={zone}
          zoneKey={zone}
          zoneLabel={t(`zoneLabels.${zone}`)}
          values={zones[zone] ?? {}}
          onChange={next => onChange(zone, next)}
          onReset={() => onReset(zone)}
          theme={theme}
        />
      ))}
    </div>
  );
}
