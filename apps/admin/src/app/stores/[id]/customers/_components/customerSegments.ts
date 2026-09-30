/**
 * Customer segment vocabulary for the Customers list — ONE badge colour
 * system, design tokens only (design.md "role-over-value": no raw
 * `bg-yellow-100`-style palette classes on this page).
 *
 * RFM segments mirror the `RfmSegment` Prisma enum. `activeBuyer` / `new` are
 * the fallbacks for a customer with no RFM snapshot yet, so every row still
 * carries a badge; `guest` marks a checkout with no customer account.
 */
export const RFM_SEGMENTS = [
  'vip',
  'loyal',
  'potential',
  'new_customer',
  'at_risk',
  'hibernating',
  'lost',
] as const;

export type RfmSegmentKey = (typeof RFM_SEGMENTS)[number];
export type SegmentBadgeKey = RfmSegmentKey | 'activeBuyer' | 'new' | 'guest';
/** Values the segment filter pills can hold. */
export type SegmentFilter = 'all' | RfmSegmentKey | 'guest';

export const SEGMENT_BADGE_CLASSES: Record<SegmentBadgeKey, string> = {
  vip: 'bg-primary/10 text-primary',
  loyal: 'bg-success/10 text-success',
  potential: 'bg-info/10 text-info',
  new_customer: 'bg-info/10 text-info',
  at_risk: 'bg-warning/10 text-warning',
  hibernating: 'bg-muted text-muted-foreground',
  lost: 'bg-destructive/10 text-destructive',
  activeBuyer: 'bg-success/10 text-success',
  new: 'bg-muted text-muted-foreground',
  guest: 'bg-muted text-muted-foreground',
};

export function isRfmSegment(value: string | undefined): value is RfmSegmentKey {
  return !!value && (RFM_SEGMENTS as readonly string[]).includes(value);
}

/**
 * Which badge a row shows: its RFM segment when it has one, otherwise
 * `guest` for a guest checkout, `activeBuyer` for anyone who has ordered,
 * and `new` for a zero-order registration.
 */
export function badgeKeyFor(
  row: { isGuest: boolean; totalOrders: number },
  segment: string | undefined
): SegmentBadgeKey {
  if (isRfmSegment(segment)) return segment;
  if (row.isGuest) return 'guest';
  return row.totalOrders >= 1 ? 'activeBuyer' : 'new';
}

/**
 * Filter pills, in canonical order: `all`, then only the RFM segments that
 * actually occur in the loaded snapshot map (a pill that can only ever show
 * an empty list is noise), then `guest` when the store has guest rows.
 */
export function segmentFilterOptions(
  loadedSegments: Iterable<string>,
  hasGuests: boolean
): SegmentFilter[] {
  const present = new Set(loadedSegments);
  return [
    'all',
    ...RFM_SEGMENTS.filter(s => present.has(s)),
    ...(hasGuests ? (['guest'] as const) : []),
  ];
}

/**
 * `?segment=` → a filter value. Unknown / missing → `'all'`, mirroring the
 * API, which ignores an unknown segment rather than 400ing (an old bookmark
 * to a retired segment still loads the list).
 */
export function parseSegmentParam(raw: string | null | undefined): SegmentFilter {
  if (raw === 'guest') return 'guest';
  return isRfmSegment(raw ?? undefined) ? (raw as RfmSegmentKey) : 'all';
}
