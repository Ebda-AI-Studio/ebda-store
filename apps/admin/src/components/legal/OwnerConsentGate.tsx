'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { apiGet, apiPost } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useT } from '../../i18n/useT';

interface ConsentDoc {
  docKey: string;
  version: string;
  title: { ar: string; en: string };
  url: { ar: string; en: string };
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled])';

/**
 * Blocking consent for a store owner with no record of the Terms and the Privacy policy (Ruling
 * CONSENT-ADMIN-1). A banner someone can dismiss is notice, not agreement: this needs an unticked box ticked and
 * an explicit "I agree", and records version + time + IP/user agent in the same table as the signup click-wrap.
 *
 * The page stays readable behind it; the server refuses admin writes with 403 CONSENT_REQUIRED until the
 * acceptance exists, so this modal is the explanation, not the enforcement. No Escape, no close button.
 * Renders nothing for anyone who is not an owner, for an owner who has accepted, and when the read fails
 * (the server still refuses a write, so a failed read cannot let a write through).
 */
export function OwnerConsentGate() {
  const t = useT('legalNotice.consent');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const { user } = useAuth();
  const [docs, setDocs] = useState<ConsentDoc[] | null>(null);
  const [ticked, setTicked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const isOwner = user?.role === 'store_admin';

  useEffect(() => {
    if (!isOwner) return;
    let cancelled = false;
    void apiGet<{ consent?: { required: boolean; documents: ConsentDoc[] } }>(
      '/api/v1/me/legal-notices'
    ).then(({ data }) => {
      if (!cancelled && data?.consent?.required) setDocs(data.consent.documents);
    });
    return () => {
      cancelled = true;
    };
  }, [isOwner]);

  useEffect(() => {
    if (docs) dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, [docs]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const items = dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  const accept = async () => {
    setSaving(true);
    setFailed(false);
    const { error } = await apiPost('/api/v1/me/legal-notices/accept', { accepted: true });
    setSaving(false);
    if (error) {
      setFailed(true);
      return;
    }
    setDocs(null);
    document.getElementById('admin-main-content')?.focus({ preventScroll: true });
  };

  if (!docs) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="owner-consent-title"
        aria-describedby="owner-consent-body"
        onKeyDown={onKeyDown}
        className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-xl"
      >
        <h2 id="owner-consent-title" className="text-lg font-semibold text-foreground">
          {t('title')}
        </h2>
        <p id="owner-consent-body" className="mt-2 text-sm text-muted-foreground">
          {t('body')}
        </p>
        <ul className="mt-4 space-y-2">
          {docs.map(d => (
            <li key={d.docKey}>
              <a
                href={d.url[locale]}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-medium text-primary underline"
                aria-label={t('readAria', { title: d.title[locale] })}
              >
                {d.title[locale]}
              </a>
            </li>
          ))}
        </ul>
        <label className="mt-5 flex min-h-11 cursor-pointer items-start gap-3 text-sm text-foreground">
          <input
            type="checkbox"
            checked={ticked}
            onChange={e => setTicked(e.target.checked)}
            className="mt-0.5 h-5 w-5 shrink-0 rounded border-border"
          />
          <span>{t('checkbox')}</span>
        </label>
        {failed && (
          <p role="alert" className="mt-3 text-sm text-destructive-ink">
            {t('failed')}
          </p>
        )}
        <Button
          type="button"
          className="mt-5 w-full justify-center"
          onClick={accept}
          disabled={!ticked || saving}
        >
          {saving ? t('saving') : t('agree')}
        </Button>
      </div>
    </div>
  );
}
