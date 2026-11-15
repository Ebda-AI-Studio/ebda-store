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
import { Disclosure } from '../../../../../components/ui/Disclosure';
import type { FontEntry } from '../../../../../components/section-design/FontsCard';

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

/** The same zones, grouped by where they sit on the storefront (plan F14): closed by default. */
export const ZONE_GROUPS = [
  { id: 'top', zones: ['beforeHeader', 'header', 'storeName'] },
  { id: 'headings', zones: ['sectionKicker', 'sectionTitle', 'sectionSubtitle', 'sectionSeeAll'] },
  {
    id: 'products',
    zones: ['categories', 'products', 'productName', 'productPrice', 'cta', 'filters'],
  },
  { id: 'footer', zones: ['footer', 'afterFooter'] },
] as const;

export function TypographyZonesField({
  zones,
  theme,
  fonts,
  onChange,
  onReset,
}: {
  /** The store's font library, so each zone's font field can list the families in their own face. */
  fonts?: FontEntry[];
  zones: Record<string, ZoneOverride | undefined>;
  theme: StoreTheme | undefined;
  /** A partial edit of one zone; the caller merges it over the zone's current value. */
  onChange: (zone: string, next: Partial<ZoneOverride>) => void;
  onReset: (zone: string) => void;
}) {
  const t = useT('orders.layout');
  return (
    <div
      className="space-y-3"
      data-testid="typography-zones-field"
      data-setting-id="builder.typography-zones"
    >
      {ZONE_GROUPS.map(g => (
        <Disclosure key={g.id} title={t(`zoneGroups.${g.id}`)} testId={`zone-group-${g.id}`}>
          <div className="space-y-3">
            {g.zones.map(zone => (
              <ZoneEditor
                key={zone}
                zoneKey={zone}
                zoneLabel={t(`zoneLabels.${zone}`)}
                values={zones[zone] ?? {}}
                onChange={next => onChange(zone, next)}
                onReset={() => onReset(zone)}
                theme={theme}
                fonts={fonts}
              />
            ))}
          </div>
        </Disclosure>
      ))}
    </div>
  );
}
