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

interface AwardPointsModalProps {
  member: LoyaltyMember;
  saving: boolean;
  onSubmit: (points: string, reason: string) => void;
  onClose: () => void;
}

export function AwardPointsModal({ member, saving, onSubmit, onClose }: AwardPointsModalProps) {
  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const points = formData.get('points') as string;
    const reason = formData.get('reason') as string;
    onSubmit(points, reason);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-card rounded-xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between p-6 border-b border-border">
          <h2 className="text-xl font-semibold text-foreground">Award Points</h2>
          <button onClick={onClose} className="p-2 text-muted-foreground hover:text-foreground">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <p className="text-sm text-muted-foreground mb-4">
              Award points to{' '}
              <strong>
                {member.customer.firstName} {member.customer.lastName}
              </strong>
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">
              Points <span className="text-destructive">*</span>
            </label>
            <input
              type="number"
              name="points"
              placeholder="Enter points (negative to deduct)"
              className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">Reason</label>
            <input
              type="text"
              name="reason"
              placeholder="Optional reason for adjustment"
              className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
            />
          </div>

          <div className="flex items-center justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-foreground border border-border rounded-lg hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 disabled:opacity-50 flex items-center gap-2"
            >
              {saving && (
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
              )}
              Award Points
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
