'use client';

import { useT } from '@/i18n/useT';
import type { LoyaltyMember } from './types';

interface AwardPointsModalProps {
  member: LoyaltyMember;
  points: string;
  reason: string;
  saving: boolean;
  onPointsChange: (value: string) => void;
  onReasonChange: (value: string) => void;
  onClose: () => void;
  onSubmit: (e: React.FormEvent) => void;
}

/**
 * Modal for manually awarding or deducting points for a single member.
 * Negative integers are allowed to support adjustments. Reason is optional
 * metadata used in the audit trail.
 */
export function AwardPointsModal({
  member,
  points,
  reason,
  saving,
  onPointsChange,
  onReasonChange,
  onClose,
  onSubmit,
}: AwardPointsModalProps) {
  const t = useT('loyalty.award');

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-card rounded-xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between p-6 border-b border-border">
          <h2 className="text-xl font-semibold text-foreground">{t('title')}</h2>
          <button
            onClick={onClose}
            className="p-2 text-muted-foreground hover:text-foreground"
            aria-label={t('close')}
          >
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

        <form onSubmit={onSubmit} className="p-6 space-y-4">
          <div>
            <p className="text-sm text-muted-foreground mb-4">
              {t('description')}{' '}
              <strong>
                {member.customer.firstName} {member.customer.lastName}
              </strong>
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">
              {t('pointsLabel')} <span className="text-destructive">*</span>
            </label>
            <input
              type="number"
              value={points}
              onChange={e => onPointsChange(e.target.value)}
              placeholder={t('pointsPlaceholder')}
              className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">
              {t('reasonLabel')}
            </label>
            <input
              type="text"
              value={reason}
              onChange={e => onReasonChange(e.target.value)}
              placeholder={t('reasonPlaceholder')}
              className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
            />
          </div>

          <div className="flex items-center justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-foreground border border-border rounded-lg hover:bg-muted"
            >
              {t('cancel')}
            </button>
            <button
              type="submit"
              disabled={saving || !points}
              className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50 flex items-center gap-2"
            >
              {saving && (
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
              )}
              {t('submit')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
