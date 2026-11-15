'use client';

/**
 * One small form for every "ask Ebda Store staff" request (SELF-SERVICE A13/A14/A16): a support request, a suspension
 * appeal, a protected-address claim, a higher store limit. Staff decide; this only files the request.
 */
import { useState } from 'react';
import { Input, Select, Textarea } from '@ebda/ui';
import { SUPPORT_TOPICS } from '@ebda/shared';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { apiPost } from '@/lib/api';

type RequestMode = 'support' | 'appeal' | 'slug' | 'cap';

interface Props {
  mode: RequestMode;
  /** Required for support + appeal. */
  storeId?: string;
  /** Pre-filled address for a slug claim. */
  slug?: string;
  /** Pre-selected topic for a support request. */
  topic?: string;
  onDone: () => void;
  onCancel?: () => void;
}

export function RequestForm({
  mode,
  storeId,
  slug: initialSlug,
  topic: initialTopic,
  onDone,
  onCancel,
}: Props) {
  const t = useT('components.support');
  const [topic, setTopic] = useState(
    initialTopic && (SUPPORT_TOPICS as readonly string[]).includes(initialTopic)
      ? initialTopic
      : 'other'
  );
  const [slug, setSlug] = useState(initialSlug ?? '');
  const [message, setMessage] = useState('');
  const [evidenceUrl, setEvidenceUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (message.trim().length < (mode === 'support' || mode === 'appeal' ? 1 : 10)) {
      setError(t('messageRequired'));
      return;
    }
    setBusy(true);
    const url = evidenceUrl.trim();
    const { error: err } =
      mode === 'support'
        ? await apiPost(`/api/v1/stores/${storeId}/support-requests`, {
            topic,
            message: message.trim(),
            pageUrl: window.location.pathname,
          })
        : mode === 'appeal'
          ? await apiPost(`/api/v1/stores/${storeId}/suspension/appeal`, {
              message: message.trim(),
            })
          : mode === 'slug'
            ? await apiPost('/api/v1/onboarding/slug-claims', {
                slug: slug.trim(),
                evidence: message.trim(),
                ...(url ? { evidenceUrl: url } : {}),
              })
            : await apiPost('/api/v1/onboarding/store-cap-requests', {
                message: message.trim(),
                ...(url ? { evidenceUrl: url } : {}),
              });
    setBusy(false);
    if (err) {
      setError(
        err.code === 'SUPPORT_REQUEST_LIMIT'
          ? t('limit')
          : err.code === 'APPEAL_ALREADY_OPEN' ||
              err.code === 'CLAIM_ALREADY_OPEN' ||
              err.code === 'CAP_REQUEST_ALREADY_OPEN'
            ? t('alreadyOpen')
            : t('failed')
      );
      return;
    }
    setSent(true);
    onDone();
  }

  if (sent) {
    return (
      <p role="status" className="rounded-lg bg-muted p-3 text-sm text-foreground">
        {t(`sent.${mode}`)}
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <p className="text-sm text-muted-foreground">{t(`intro.${mode}`)}</p>
      {error && (
        <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive-ink">
          {error}
        </div>
      )}
      {mode === 'support' && (
        <Select
          label={t('topic')}
          value={topic}
          onChange={e => setTopic(e.target.value)}
          options={SUPPORT_TOPICS.map(k => ({ value: k, label: t(`topics.${k}`) }))}
        />
      )}
      {mode === 'slug' && (
        <Input
          label={t('slug')}
          dir="ltr"
          value={slug}
          onChange={e => setSlug(e.target.value.toLowerCase())}
        />
      )}
      <Textarea
        label={t(`message.${mode}`)}
        value={message}
        onChange={e => setMessage(e.target.value)}
        maxLength={mode === 'support' ? 2000 : 1000}
        rows={5}
      />
      {(mode === 'slug' || mode === 'cap') && (
        <Input
          label={t('evidenceUrl')}
          dir="ltr"
          value={evidenceUrl}
          onChange={e => setEvidenceUrl(e.target.value)}
          placeholder="https://"
        />
      )}
      <div className="flex justify-end gap-3">
        {onCancel && (
          <Button variant="outline" type="button" onClick={onCancel} disabled={busy}>
            {t('cancel')}
          </Button>
        )}
        <Button type="submit" disabled={busy} isLoading={busy}>
          {t('send')}
        </Button>
      </div>
    </form>
  );
}
