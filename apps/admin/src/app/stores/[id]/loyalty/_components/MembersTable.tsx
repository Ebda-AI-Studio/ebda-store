'use client';

import { useT } from '@/i18n/useT';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { TIER_COLORS, TIER_KEYS, type LoyaltyMember, type TierKey } from './types';

interface MembersTableProps {
  members: LoyaltyMember[];
  tierFilter: string;
  onTierFilterChange: (tier: string) => void;
  onAwardClick: (member: LoyaltyMember) => void;
}

const FILTER_TIERS: Array<'all' | TierKey> = ['all', ...TIER_KEYS];

/**
 * Loyalty members list with tier filter chips. Uses `<DataTable>` for the
 * responsive table-or-cards switch; the empty state is its own card so
 * filter chips remain visible at the top.
 */
export function MembersTable({
  members,
  tierFilter,
  onTierFilterChange,
  onAwardClick,
}: MembersTableProps) {
  const t = useT('loyalty.members');
  const tTiers = useT('loyalty.tiers');

  const tierLabel = (key: string) => {
    if (key === 'all') return t('all');
    return tTiers(key);
  };

  const columns: DataTableColumn<LoyaltyMember>[] = [
    {
      header: t('columns.member'),
      primaryOnMobile: true,
      cell: member => (
        <div>
          <div className="font-medium text-foreground">
            {member.customer.firstName} {member.customer.lastName}
          </div>
          <div className="text-sm text-muted-foreground">{member.customer.email}</div>
        </div>
      ),
    },
    {
      header: t('columns.tier'),
      mobileBadge: true,
      cell: member => (
        <span
          className={`px-2 py-1 rounded-full text-xs font-medium ${TIER_COLORS[member.tier]?.bg} ${TIER_COLORS[member.tier]?.text}`}
        >
          {tierLabel(member.tier)}
        </span>
      ),
    },
    {
      header: t('columns.balance'),
      cell: member => (
        <span className="font-medium text-foreground">{member.points.toLocaleString()}</span>
      ),
    },
    {
      header: t('columns.totalEarned'),
      cell: member => <span className="text-success">+{member.totalEarned.toLocaleString()}</span>,
    },
    {
      header: t('columns.totalRedeemed'),
      cell: member => (
        <span className="text-primary">-{member.totalRedeemed.toLocaleString()}</span>
      ),
    },
    {
      header: t('columns.actions'),
      alignEnd: true,
      mobileActions: true,
      cell: member => (
        <button
          type="button"
          onClick={() => onAwardClick(member)}
          className="inline-flex items-center px-3 py-2 min-h-9 rounded-lg text-primary hover:bg-primary/5 text-sm font-medium"
        >
          {t('awardPoints')}
        </button>
      ),
    },
  ];

  const emptyState = (
    <div className="bg-card rounded-xl border border-border p-12 text-center">
      <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mx-auto mb-4">
        <svg
          className="w-8 h-8 text-muted-foreground"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
          />
        </svg>
      </div>
      <h3 className="text-lg font-semibold text-foreground mb-2">{t('emptyTitle')}</h3>
      <p className="text-muted-foreground">{t('emptyDescription')}</p>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 p-4 bg-muted border border-border rounded-xl">
        {FILTER_TIERS.map(tier => (
          <button
            type="button"
            key={tier}
            onClick={() => onTierFilterChange(tier)}
            className={`px-4 py-2 min-h-9 rounded-lg text-sm font-medium transition-colors ${
              tierFilter === tier
                ? 'bg-primary text-white'
                : 'bg-card text-foreground hover:bg-muted border border-border'
            }`}
          >
            {tierLabel(tier)}
          </button>
        ))}
      </div>

      <DataTable<LoyaltyMember>
        ariaLabel={t('tableLabel')}
        columns={columns}
        rows={members}
        rowKey={m => m.id}
        emptyState={emptyState}
      />
    </div>
  );
}
