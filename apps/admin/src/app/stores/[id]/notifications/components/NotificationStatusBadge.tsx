/**
 * Status pill for rows in the notifications-log table. Distinct from
 * ShipmentStatusBadge because the status vocabulary is different
 * (sent/delivered/failed/pending/queued vs. the shipment set) and the
 * colors here intentionally treat "sent" and "delivered" as equivalent
 * success states.
 */
const COLORS: Record<string, string> = {
  sent: 'bg-success/10 text-success',
  delivered: 'bg-success/10 text-success',
  failed: 'bg-destructive/10 text-destructive',
  pending: 'bg-muted text-muted-foreground',
  queued: 'bg-primary/10 text-primary',
};

export function NotificationStatusBadge({ status }: { status: string }) {
  const cls = COLORS[status] ?? 'bg-muted text-foreground';
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${cls}`}>
      {status}
    </span>
  );
}
