/**
 * Shipment status pill used in the shipments table on the shipping-carriers
 * admin page. Maps the carrier-agnostic status strings (created /
 * picked_up / in_transit / out_for_delivery / delivered / failed / returned
 * / cancelled) to theme-token color combos.
 */

const STATUS_COLORS: Record<string, string> = {
  created: 'bg-muted text-foreground',
  picked_up: 'bg-info/10 text-info dark:bg-info/30 dark:text-info',
  in_transit: 'bg-warning/10 text-warning dark:bg-warning/30 dark:text-warning',
  out_for_delivery: 'bg-primary/10 text-primary',
  delivered: 'bg-success/10 text-success dark:bg-success/30 dark:text-success',
  failed: 'bg-destructive/10 text-destructive dark:bg-destructive/30 dark:text-destructive',
  returned: 'bg-info/10 text-info dark:bg-info/30 dark:text-info',
  cancelled: 'bg-muted text-muted-foreground',
};

const STATUS_LABELS: Record<string, string> = {
  created: 'Created',
  picked_up: 'Picked Up',
  in_transit: 'In Transit',
  out_for_delivery: 'Out for Delivery',
  delivered: 'Delivered',
  failed: 'Failed',
  returned: 'Returned',
  cancelled: 'Cancelled',
};

export function ShipmentStatusBadge({ status }: { status: string }) {
  const cls = STATUS_COLORS[status] ?? 'bg-muted text-foreground';
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${cls}`}>
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}
