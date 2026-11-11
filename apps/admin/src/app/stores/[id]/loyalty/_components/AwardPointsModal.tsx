'use client';

import { useT } from '@/i18n/useT';
import { BottomSheet } from '@/components/mobile/BottomSheet';
import type { LoyaltyMember } from './types';
import { Button } from '@/components/ui/Button';

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
  const FORM_ID = 'loyalty-award-form';

  return (
    <BottomSheet
      open
      onClose={onClose}
      title={t('title')}
      footer={
        <div className="flex items-center justify-end gap-3">
          <Button variant="outline" size="md" type="button" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            variant="default"
            size="md"
            type="submit"
            form={FORM_ID}
            disabled={saving || !points}
          >
            {saving && (
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
            )}
            {t('submit')}
          </Button>
        </div>
      }
    >
      <form id={FORM_ID} onSubmit={onSubmit} className="space-y-4">
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
            {t('pointsLabel')} <span className="text-destructive-ink">*</span>
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
      </form>
    </BottomSheet>
  );
}
