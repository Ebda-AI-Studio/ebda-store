'use client';

import { useT } from '@/i18n/useT';
import { TIER_COLORS, TIER_KEYS, type LoyaltyMember, type TierKey } from './types';

interface MembersTableProps {
  members: LoyaltyMember[];
  tierFilter: string;
  onTierFilterChange: (tier: string) => void;
  onAwardClick: (member: LoyaltyMember) => void;
}

const FILTER_TIERS: Array<'all' | TierKey> = ['all', ...TIER_KEYS];

/**
 * Loyalty members list with tier filter chips. Shows an empty state with a
 * friendly icon when no members match the current filter.
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

  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
      <div className="flex gap-2 p-4 bg-muted border-b border-border">
        {FILTER_TIERS.map(tier => (
          <button
            key={tier}
            onClick={() => onTierFilterChange(tier)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tierFilter === tier
                ? 'bg-primary text-white'
                : 'bg-card text-foreground hover:bg-muted border border-border'
            }`}
          >
            {tierLabel(tier)}
          </button>
        ))}
      </div>

      {members.length === 0 ? (
        <div className="p-12 text-center">
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
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full" aria-label={t('tableLabel')}>
            <thead>
              <tr className="bg-muted border-b border-border">
                <th
                  scope="col"
                  className="text-start px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                >
                  {t('columns.member')}
                </th>
                <th
                  scope="col"
                  className="text-start px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                >
                  {t('columns.tier')}
                </th>
                <th
                  scope="col"
                  className="text-start px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                >
                  {t('columns.balance')}
                </th>
                <th
                  scope="col"
                  className="text-start px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                >
                  {t('columns.totalEarned')}
                </th>
                <th
                  scope="col"
                  className="text-start px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                >
                  {t('columns.totalRedeemed')}
                </th>
                <th
                  scope="col"
                  className="text-end px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                >
                  {t('columns.actions')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {members.map(member => (
                <tr key={member.id} className="hover:bg-muted">
                  <td className="px-6 py-4">
                    <div>
                      <div className="font-medium text-foreground">
                        {member.customer.firstName} {member.customer.lastName}
                      </div>
                      <div className="text-sm text-muted-foreground">{member.customer.email}</div>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <span
                      className={`px-2 py-1 rounded-full text-xs font-medium ${TIER_COLORS[member.tier]?.bg} ${TIER_COLORS[member.tier]?.text}`}
                    >
                      {tierLabel(member.tier)}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <span className="font-medium text-foreground">
                      {member.points.toLocaleString()}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-success">+{member.totalEarned.toLocaleString()}</td>
                  <td className="px-6 py-4 text-primary">
                    -{member.totalRedeemed.toLocaleString()}
                  </td>
                  <td className="px-6 py-4 text-end">
                    <button
                      onClick={() => onAwardClick(member)}
                      className="text-primary hover:text-primary/90 text-sm font-medium"
                    >
                      {t('awardPoints')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
