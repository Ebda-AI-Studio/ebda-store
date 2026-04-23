'use client';

interface LoyaltyMember {
  id: string;
  customerId: string;
  points: number;
  totalEarned: number;
  totalRedeemed: number;
  tier: string;
  customer: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
  };
}

const TIER_COLORS: Record<string, { bg: string; text: string; icon: string }> = {
  bronze: { bg: 'bg-amber-100', text: 'text-amber-700', icon: 'bg-amber-500' },
  silver: { bg: 'bg-muted', text: 'text-foreground', icon: 'bg-muted-foreground' },
  gold: { bg: 'bg-warning/10', text: 'text-warning', icon: 'bg-warning' },
  platinum: { bg: 'bg-info/10', text: 'text-info', icon: 'bg-info' },
};

interface LoyaltyMembersTableProps {
  members: LoyaltyMember[];
  tierFilter: string;
  onTierFilterChange: (tier: string) => void;
  onAwardPoints: (member: LoyaltyMember) => void;
}

export function LoyaltyMembersTable({
  members,
  tierFilter,
  onTierFilterChange,
  onAwardPoints,
}: LoyaltyMembersTableProps) {
  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
      {/* Tier Filter */}
      <div className="flex gap-2 p-4 bg-muted border-b border-border">
        {['all', 'bronze', 'silver', 'gold', 'platinum'].map(t => (
          <button
            key={t}
            onClick={() => onTierFilterChange(t)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors capitalize ${
              tierFilter === t
                ? 'bg-primary text-white'
                : 'bg-card text-foreground hover:bg-muted border border-border'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Members Table */}
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
          <h3 className="text-lg font-semibold text-foreground mb-2">No Members Yet</h3>
          <p className="text-muted-foreground">
            Customers will appear here when they join your loyalty program
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full" aria-label="Loyalty members">
            <thead>
              <tr className="bg-muted border-b border-border">
                <th
                  scope="col"
                  className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                >
                  Member
                </th>
                <th
                  scope="col"
                  className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                >
                  Tier
                </th>
                <th
                  scope="col"
                  className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                >
                  Points Balance
                </th>
                <th
                  scope="col"
                  className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                >
                  Total Earned
                </th>
                <th
                  scope="col"
                  className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                >
                  Total Redeemed
                </th>
                <th
                  scope="col"
                  className="text-right px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                >
                  Actions
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
                      className={`px-2 py-1 rounded-full text-xs font-medium capitalize ${TIER_COLORS[member.tier]?.bg} ${TIER_COLORS[member.tier]?.text}`}
                    >
                      {member.tier}
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
                  <td className="px-6 py-4 text-right">
                    <button
                      onClick={() => onAwardPoints(member)}
                      className="text-primary hover:text-primary/90 text-sm font-medium"
                    >
                      Award Points
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
