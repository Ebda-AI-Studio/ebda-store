'use client';

import { useState } from 'react';
import { useT } from '@/i18n/useT';
import { Button } from '@/components/ui/Button';
import { FIELD_CLASSES, TEXTAREA_CLASSES } from '@/components/ui/tokens';

export type DecisionKind = 'approve' | 'reject' | 'revoke';

interface Props {
  kind: DecisionKind;
  businessName: string;
  /** Active wholesale groups only (the API refuses anything else with 422). */
  groups: Array<{ id: string; name: string; nameAr: string | null }>;
  onCancel: () => void;
  onConfirm: (input: { groupId?: string; note?: string }) => Promise<void>;
}

/** Approve (group picker), reject (note SHOWN TO THE APPLICANT) or revoke (note) for one application. */
export function ApplicationDecisionModal({
  kind,
  businessName,
  groups,
  onCancel,
  onConfirm,
}: Props) {
  const t = useT('wholesale.applications.modal');
  const [groupId, setGroupId] = useState(groups[0]?.id ?? '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const noGroups = kind === 'approve' && groups.length === 0;

  const submit = async () => {
    setBusy(true);
    try {
      await onConfirm(kind === 'approve' ? { groupId } : { note: note.trim() });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="wholesale-decision-title"
        className="w-full max-w-md rounded-lg bg-background p-5 shadow-md"
      >
        <h2 id="wholesale-decision-title" className="mb-1 text-lg font-semibold">
          {t(`${kind}Title`)}
        </h2>
        <p className="mb-4 text-sm text-muted-foreground">
          <bdi>{businessName}</bdi>
        </p>

        {kind === 'approve' ? (
          noGroups ? (
            <p role="alert" className="mb-4 text-sm text-destructive-ink">
              {t('noGroups')}
            </p>
          ) : (
            <label className="mb-4 block">
              <span className="mb-1 block text-sm font-medium">{t('group')}</span>
              <select
                value={groupId}
                onChange={e => setGroupId(e.target.value)}
                className={FIELD_CLASSES}
              >
                {groups.map(g => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                    {g.nameAr ? ` / ${g.nameAr}` : ''}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-xs text-muted-foreground">{t('groupHint')}</span>
            </label>
          )
        ) : (
          <label className="mb-4 block">
            <span className="mb-1 block text-sm font-medium">
              {kind === 'reject' ? t('noteToApplicant') : t('noteRevoke')}
            </span>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              maxLength={500}
              rows={3}
              className={TEXTAREA_CLASSES}
            />
            {kind === 'reject' ? (
              <span className="mt-1 block text-xs text-muted-foreground">
                {t('noteVisibleHint')}
              </span>
            ) : (
              <span className="mt-1 block text-xs text-muted-foreground">{t('revokeHint')}</span>
            )}
          </label>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="md" type="button" onClick={onCancel}>
            {t('cancel')}
          </Button>
          <Button
            variant="default"
            size="md"
            type="button"
            onClick={() => void submit()}
            disabled={busy || noGroups || (kind === 'approve' && !groupId)}
          >
            {busy ? t('working') : t(`${kind}Confirm`)}
          </Button>
        </div>
      </div>
    </div>
  );
}
