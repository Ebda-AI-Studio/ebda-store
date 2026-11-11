'use client';

import { Button } from '@/components/ui/Button';
import { useState } from 'react';
import { apiPut } from '../../lib/api';
import { useT } from '@/i18n/useT';

/** The store's optional packing-slip footer text (`settings.packingSlipNote`, <= 300 chars). Saves only its key. */
export function PackingSlipNoteField({
  storeId,
  value,
  onSaved,
}: {
  storeId: string;
  value: string | undefined;
  onSaved: (note: string) => void;
}) {
  const t = useT('packingSlip');
  const [note, setNote] = useState(value ?? '');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const { error } = await apiPut(`/api/v1/stores/${storeId}`, {
        settings: { packingSlipNote: note.trim() === '' ? null : note.trim() },
      });
      if (error) setMsg({ ok: false, text: error.message || t('noteFailed') });
      else {
        onSaved(note.trim());
        setMsg({ ok: true, text: t('noteSaved') });
      }
    } catch {
      setMsg({ ok: false, text: t('noteFailed') });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-3 rounded-xl border bg-card p-4 shadow-sm">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{t('noteTitle')}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('noteHint')}</p>
      </div>
      <textarea
        value={note}
        onChange={e => setNote(e.target.value)}
        maxLength={300}
        rows={2}
        placeholder={t('notePlaceholder')}
        aria-label={t('noteTitle')}
        className="w-full max-w-md rounded-lg border border-border bg-background px-3 py-2 text-sm"
      />
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          type="button"
          onClick={save}
          disabled={saving || note.trim() === (value ?? '').trim()}
          className="font-semibold"
        >
          {t('noteSave')}
        </Button>
        {msg && (
          <span
            role="status"
            className={`text-xs ${msg.ok ? 'text-success-ink' : 'text-destructive-ink'}`}
          >
            {msg.text}
          </span>
        )}
      </div>
    </section>
  );
}
