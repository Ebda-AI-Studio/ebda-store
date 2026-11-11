'use client';

import { useT } from '@/i18n/useT';
import { OrderStatusBadge } from '../../../../../components/OrderStatusBadge';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { SHIPMENT_COLORS } from './types';
import type { Shipment } from './types';
import { withNumerals } from '@ebda/shared';

import { Button } from '@/components/ui/Button';
import { FIELD_CLASSES } from '@/components/ui/tokens';
interface ShipmentsTableProps {
  shipments: Shipment[];
  total: number;
  page: number;
  pages: number;
  carrierFilter: string;
  statusFilter: string;
  onCarrierFilterChange: (value: string) => void;
  onStatusFilterChange: (value: string) => void;
  onPageChange: (updater: (prev: number) => number) => void;
}

const CARRIER_LABEL_KEYS: Record<string, string> = {
  bosta: 'carrierNames.bosta',
  shipblu: 'carrierNames.shipblu',
  mylerz: 'carrierNames.mylerz',
  aramex: 'carrierNames.aramex',
  manual: 'carrierNames.manual',
};

/**
 * Active shipments table — filter bar (carrier/status) + table + pagination.
 * Handles its own empty state when no rows match the current filters.
 */
export function ShipmentsTable({
  shipments,
  total,
  page,
  pages,
  carrierFilter,
  statusFilter,
  onCarrierFilterChange,
  onStatusFilterChange,
  onPageChange,
}: ShipmentsTableProps) {
  const t = useT('shipping.carriers.shipments');

  const carrierLabel = (carrier: string): string => {
    const key = CARRIER_LABEL_KEYS[carrier];
    return key ? t(key) : carrier;
  };

  const columns: DataTableColumn<Shipment>[] = [
    {
      header: t('columns.orderNumber'),
      primaryOnMobile: true,
      cell: shipment => (
        <span className="text-sm font-medium text-foreground">{shipment.orderNumber}</span>
      ),
    },
    {
      header: t('columns.carrier'),
      cell: shipment => (
        <span className="text-sm text-foreground capitalize">
          {carrierLabel(shipment.carrierCode)}
        </span>
      ),
    },
    {
      header: t('columns.trackingNumber'),
      cell: shipment => (
        <span className="text-sm text-muted-foreground font-mono">
          {shipment.trackingNumber || '—'}
        </span>
      ),
    },
    {
      header: t('columns.status'),
      mobileBadge: true,
      cell: shipment => (
        <OrderStatusBadge
          status={shipment.status}
          namespace="shipping.carriers.shipments.statuses"
          colorMap={SHIPMENT_COLORS}
        />
      ),
    },
    {
      header: t('columns.created'),
      cell: shipment => (
        <span className="text-sm text-muted-foreground whitespace-nowrap">
          {new Date(shipment.createdAt).toLocaleDateString(undefined, withNumerals())}
        </span>
      ),
    },
  ];

  const emptyState = (
    <div className="p-12 text-center">
      <div className="w-12 h-12 bg-muted rounded-full flex items-center justify-center mx-auto mb-3">
        <svg
          className="w-6 h-6 text-muted-foreground"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M9 17a2 2 0 11-4 0 2 2 0 014 0zM19 17a2 2 0 11-4 0 2 2 0 014 0z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h1m8-1a1 1 0 01-1 1H9m4-1V8a1 1 0 011-1h2.586a1 1 0 01.707.293l3.414 3.414a1 1 0 01.293.707V16a1 1 0 01-1 1h-1m-6-1a1 1 0 001 1h1M5 17a2 2 0 104 0m-4 0a2 2 0 114 0m6 0a2 2 0 104 0m-4 0a2 2 0 114 0"
          />
        </svg>
      </div>
      <p className="text-muted-foreground text-sm">{t('empty')}</p>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="bg-card rounded-md border border-border overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              {total === 1 ? t('totalOne', { total }) : t('totalOther', { total })}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={carrierFilter}
              onChange={e => onCarrierFilterChange(e.target.value)}
              aria-label={t('filters.carrierLabel')}
              className={FIELD_CLASSES}
            >
              <option value="all">{t('filters.allCarriers')}</option>
              <option value="bosta">{t('carrierNames.bosta')}</option>
              <option value="shipblu">{t('carrierNames.shipblu')}</option>
              <option value="mylerz">{t('carrierNames.mylerz')}</option>
              <option value="aramex">{t('carrierNames.aramex')}</option>
              <option value="manual">{t('carrierNames.manual')}</option>
            </select>
            <select
              value={statusFilter}
              onChange={e => onStatusFilterChange(e.target.value)}
              aria-label={t('filters.statusLabel')}
              className={FIELD_CLASSES}
            >
              <option value="all">{t('filters.allStatuses')}</option>
              <option value="created">{t('statuses.created')}</option>
              <option value="picked_up">{t('statuses.picked_up')}</option>
              <option value="in_transit">{t('statuses.in_transit')}</option>
              <option value="out_for_delivery">{t('statuses.out_for_delivery')}</option>
              <option value="delivered">{t('statuses.delivered')}</option>
              <option value="failed">{t('statuses.failed')}</option>
              <option value="returned">{t('statuses.returned')}</option>
              <option value="cancelled">{t('statuses.cancelled')}</option>
              <option value="creation_failed">{t('statuses.creation_failed')}</option>
            </select>
          </div>
        </div>
      </div>

      <DataTable<Shipment>
        ariaLabel={t('tableLabel')}
        columns={columns}
        rows={shipments}
        rowKey={shipment => shipment.id}
        emptyState={emptyState}
      />

      {shipments.length > 0 && pages > 1 && (
        <div className="flex items-center justify-between px-6 py-4 rounded-md border border-border bg-card">
          <p className="text-sm text-muted-foreground">
            {t('pagination.summary', { page, pages, total })}
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              onClick={() => onPageChange(p => Math.max(1, p - 1))}
              disabled={page === 1}
              variant="outline"
            >
              {t('pagination.previous')}
            </Button>
            <Button
              type="button"
              onClick={() => onPageChange(p => Math.min(pages, p + 1))}
              disabled={page === pages}
              variant="outline"
            >
              {t('pagination.next')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
