'use client';

import { useT } from '@/i18n/useT';

interface ShippingZone {
  id: string;
  name: string;
  nameAr: string | null;
  areas: string[];
  areasAr: string[];
  deliveryFee: number;
  freeShippingThreshold: number | null;
  estimatedDays: number | null;
  estimatedDaysMin: number | null;
  estimatedDaysMax: number | null;
  position: number;
  isActive: boolean;
  createdAt: string;
}

interface ShippingZonesTableProps {
  zones: ShippingZone[];
  onEdit: (zone: ShippingZone) => void;
  onToggle: (zone: ShippingZone) => void;
  onDelete: (zone: ShippingZone) => void;
}

export function ShippingZonesTable({ zones, onEdit, onToggle, onDelete }: ShippingZonesTableProps) {
  const t = useT('shipping.table');

  const formatDeliveryTime = (zone: ShippingZone) => {
    if (zone.estimatedDaysMin && zone.estimatedDaysMax) {
      return t('daysRange', { min: zone.estimatedDaysMin, max: zone.estimatedDaysMax });
    }
    if (zone.estimatedDays) {
      return t('daysSingle', { days: zone.estimatedDays });
    }
    return t('dashPlaceholder');
  };

  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
      <table className="w-full" aria-label={t('label')}>
        <thead>
          <tr className="bg-muted border-b border-border">
            <th
              scope="col"
              className="text-start px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
            >
              {t('zone')}
            </th>
            <th
              scope="col"
              className="text-start px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
            >
              {t('areas')}
            </th>
            <th
              scope="col"
              className="text-start px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
            >
              {t('deliveryFee')}
            </th>
            <th
              scope="col"
              className="text-start px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
            >
              {t('freeShipping')}
            </th>
            <th
              scope="col"
              className="text-start px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
            >
              {t('estimatedDelivery')}
            </th>
            <th
              scope="col"
              className="text-start px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
            >
              {t('status')}
            </th>
            <th
              scope="col"
              className="text-end px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
            >
              {t('actions')}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {zones.map(zone => (
            <tr key={zone.id} className="hover:bg-muted">
              <td className="px-6 py-4">
                <div>
                  <div className="font-medium text-foreground">{zone.name}</div>
                  {zone.nameAr && (
                    <div className="text-sm text-muted-foreground font-arabic">{zone.nameAr}</div>
                  )}
                </div>
              </td>
              <td className="px-6 py-4">
                <div className="flex flex-wrap gap-1 max-w-xs">
                  {zone.areas.slice(0, 3).map((area, i) => (
                    <span key={i} className="px-2 py-0.5 bg-muted text-foreground text-xs rounded">
                      {area}
                    </span>
                  ))}
                  {zone.areas.length > 3 && (
                    <span className="px-2 py-0.5 bg-muted text-muted-foreground text-xs rounded">
                      {t('moreAreas', { count: zone.areas.length - 3 })}
                    </span>
                  )}
                </div>
              </td>
              <td className="px-6 py-4">
                <span className="font-medium text-foreground">
                  {t('priceWithCurrency', { amount: (zone.deliveryFee / 1000).toFixed(3) })}
                </span>
              </td>
              <td className="px-6 py-4">
                {zone.freeShippingThreshold ? (
                  <span className="text-success text-sm">
                    {t('freeShippingOver', {
                      amount: (zone.freeShippingThreshold / 1000).toFixed(3),
                    })}
                  </span>
                ) : (
                  <span className="text-muted-foreground">{t('dashPlaceholder')}</span>
                )}
              </td>
              <td className="px-6 py-4 text-sm text-muted-foreground">
                {formatDeliveryTime(zone)}
              </td>
              <td className="px-6 py-4">
                <button
                  onClick={() => onToggle(zone)}
                  className={`px-2 py-1 rounded-full text-xs font-medium ${
                    zone.isActive
                      ? 'bg-success/10 text-success dark:bg-success/30 dark:text-success'
                      : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {zone.isActive ? t('active') : t('inactive')}
                </button>
              </td>
              <td className="px-6 py-4 text-end">
                <div className="flex items-center justify-end gap-2">
                  <button
                    onClick={() => onEdit(zone)}
                    className="p-2 text-muted-foreground hover:text-primary transition-colors"
                    title={t('edit')}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                      />
                    </svg>
                  </button>
                  <button
                    onClick={() => onDelete(zone)}
                    className="p-2 text-muted-foreground hover:text-destructive transition-colors"
                    title={t('delete')}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                      />
                    </svg>
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export type { ShippingZone };
