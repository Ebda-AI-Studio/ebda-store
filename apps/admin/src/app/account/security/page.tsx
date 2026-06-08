'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button, Input, useToast } from '@force/ui';
import { AdminLayout } from '../../../components/AdminLayout';
import { apiPost, apiGet } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { useT } from '@/i18n/useT';

// ── Types ────────────────────────────────────────────────────────────────────

type Step =
  | 'idle'
  | 'enrolling' // QR code shown, waiting for user to confirm TOTP code
  | 'backup' // backup codes displayed after successful enroll
  | 'disabling'; // disable confirmation UI

interface MfaStatus {
  mfaEnabled: boolean;
  mfaEnrolledAt: string | null;
}

interface EnrollBeginData {
  secret: string;
  qr: string;
}

// ── Component ────────────────────────────────────────────────────────────────

export default function SecurityPage() {
  const t = useT('account.security');
  const { user } = useAuth();
  const { success: toastSuccess, error: toastError } = useToast();

  // Status
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [isLoadingStatus, setIsLoadingStatus] = useState(true);

  // Enroll flow
  const [step, setStep] = useState<Step>('idle');
  const [enrollData, setEnrollData] = useState<EnrollBeginData | null>(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [currentCode, setCurrentCode] = useState(''); // required when re-enrolling (already enabled)
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [enrollError, setEnrollError] = useState('');

  // Backup codes
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [copiedCodes, setCopiedCodes] = useState(false);

  // Disable flow
  const [disableCode, setDisableCode] = useState('');
  const [disableError, setDisableError] = useState('');

  // ── Fetch current MFA status ─────────────────────────────────────────────
  const fetchStatus = useCallback(async () => {
    setIsLoadingStatus(true);
    const { data, error } = await apiGet<{
      user?: { mfaEnabled?: boolean; mfaEnrolledAt?: string | null };
    }>('/api/v1/auth/me');
    if (error || !data) {
      toastError(t('errorLoading'), undefined);
    } else {
      setStatus({
        mfaEnabled: data.user?.mfaEnabled ?? false,
        mfaEnrolledAt: data.user?.mfaEnrolledAt ?? null,
      });
    }
    setIsLoadingStatus(false);
  }, [t, toastError]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // ── Enroll: begin ────────────────────────────────────────────────────────
  async function handleBeginEnroll() {
    setEnrollError('');
    setIsSubmitting(true);
    try {
      // If already enabled, we need the current TOTP code (re-enroll)
      const body = status?.mfaEnabled ? { code: currentCode } : undefined;
      const { data, error } = await apiPost<EnrollBeginData>('/api/v1/auth/mfa/enroll/begin', body);
      if (error) {
        setEnrollError(error.message || t('errorBegin'));
        return;
      }
      if (data) {
        setEnrollData(data);
        setStep('enrolling');
        setVerifyCode('');
        setCurrentCode('');
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  // ── Enroll: verify ───────────────────────────────────────────────────────
  async function handleVerifyEnroll(e: React.FormEvent) {
    e.preventDefault();
    setEnrollError('');
    setIsSubmitting(true);
    try {
      const { data, error } = await apiPost<{ backupCodes: string[] }>(
        '/api/v1/auth/mfa/enroll/verify',
        { code: verifyCode.trim() }
      );
      if (error) {
        setEnrollError(error.message || t('errorVerify'));
        setVerifyCode('');
        return;
      }
      setBackupCodes(data?.backupCodes ?? []);
      setStep('backup');
      setStatus(prev =>
        prev ? { ...prev, mfaEnabled: true, mfaEnrolledAt: new Date().toISOString() } : prev
      );
      toastSuccess(t('successEnabled'), undefined);
    } finally {
      setIsSubmitting(false);
    }
  }

  // ── Copy backup codes ────────────────────────────────────────────────────
  function handleCopyCodes() {
    navigator.clipboard.writeText(backupCodes.join('\n')).then(() => {
      setCopiedCodes(true);
      setTimeout(() => setCopiedCodes(false), 2000);
    });
  }

  // ── Disable ──────────────────────────────────────────────────────────────
  async function handleDisable(e: React.FormEvent) {
    e.preventDefault();
    setDisableError('');
    setIsSubmitting(true);
    try {
      const { error } = await apiPost('/api/v1/auth/mfa/disable', { code: disableCode.trim() });
      if (error) {
        setDisableError(error.message || t('errorDisable'));
        setDisableCode('');
        return;
      }
      setStatus(prev => (prev ? { ...prev, mfaEnabled: false, mfaEnrolledAt: null } : prev));
      setStep('idle');
      setDisableCode('');
      toastSuccess(t('successDisabled'), undefined);
    } finally {
      setIsSubmitting(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')}>
      <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6 space-y-6">
        {/* Super-admin required banner */}
        {user?.role === 'super_admin' && status && !status.mfaEnabled && step === 'idle' && (
          <div className="flex items-start gap-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30">
            <svg
              className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
              />
            </svg>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                {t('mfaBanner')}
              </p>
              <Button
                type="button"
                className="mt-3"
                size="sm"
                onClick={handleBeginEnroll}
                disabled={isSubmitting}
              >
                {t('mfaBannerCta')}
              </Button>
            </div>
          </div>
        )}

        {/* Status card */}
        {isLoadingStatus ? (
          <div className="rounded-2xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            {t('loading')}
          </div>
        ) : (
          <>
            {/* ── Backup codes display (after successful enroll) ──────────────── */}
            {step === 'backup' && (
              <div className="rounded-2xl border border-border bg-card p-6 space-y-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-success/10 text-success dark:bg-success/15">
                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  </div>
                  <div>
                    <h3 className="font-semibold text-foreground">{t('backupCodesTitle')}</h3>
                    <p className="text-sm text-muted-foreground">{t('backupCodesDescription')}</p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 rounded-xl bg-muted/50 p-4 font-mono text-sm">
                  {backupCodes.map((code, i) => (
                    <span key={i} className="text-foreground">
                      {code}
                    </span>
                  ))}
                </div>

                <div className="flex flex-col sm:flex-row gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleCopyCodes}
                    className="flex-1"
                  >
                    {copiedCodes ? t('codeCopied') : t('copyCodesButton')}
                  </Button>
                  <Button
                    type="button"
                    className="flex-1"
                    onClick={() => {
                      setStep('idle');
                      setBackupCodes([]);
                    }}
                  >
                    {t('savedButton')}
                  </Button>
                </div>
              </div>
            )}

            {/* ── Enrollment flow ─────────────────────────────────────────────── */}
            {step === 'enrolling' && enrollData && (
              <div className="rounded-2xl border border-border bg-card p-6 space-y-6">
                <div>
                  <h3 className="font-semibold text-foreground">{t('scanTitle')}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{t('scanDescription')}</p>
                </div>

                {/* QR code */}
                <div className="flex justify-center">
                  <img
                    src={enrollData.qr}
                    alt="2FA QR code"
                    className="h-48 w-48 rounded-xl border border-border"
                  />
                </div>

                {/* Manual key */}
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">{t('manualKey')}</p>
                  <code className="block w-full break-all rounded-lg bg-muted px-3 py-2 text-sm font-mono text-foreground">
                    {enrollData.secret}
                  </code>
                </div>

                {/* Verify form */}
                <form onSubmit={handleVerifyEnroll} className="space-y-4">
                  {enrollError && (
                    <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                      {enrollError}
                    </div>
                  )}
                  <div>
                    <label
                      htmlFor="verify-code"
                      className="block text-sm font-medium text-foreground"
                    >
                      {t('codeLabel')}
                    </label>
                    <Input
                      id="verify-code"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      autoFocus
                      required
                      value={verifyCode}
                      onChange={e => setVerifyCode(e.target.value)}
                      className="mt-1 text-center tracking-widest"
                      placeholder={t('codePlaceholder')}
                      maxLength={6}
                    />
                  </div>
                  <div className="flex gap-3">
                    <Button
                      type="button"
                      variant="outline"
                      className="flex-1"
                      onClick={() => {
                        setStep('idle');
                        setEnrollData(null);
                        setEnrollError('');
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="submit"
                      className="flex-1"
                      disabled={isSubmitting || verifyCode.length !== 6}
                    >
                      {isSubmitting ? t('verifying') : t('verifyButton')}
                    </Button>
                  </div>
                </form>
              </div>
            )}

            {/* ── Disable flow ─────────────────────────────────────────────────── */}
            {step === 'disabling' && (
              <div className="rounded-2xl border border-destructive/30 bg-card p-6 space-y-4">
                <div>
                  <h3 className="font-semibold text-foreground">{t('disableConfirmTitle')}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t('disableConfirmDescription')}
                  </p>
                </div>
                <form onSubmit={handleDisable} className="space-y-4">
                  {disableError && (
                    <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                      {disableError}
                    </div>
                  )}
                  <div>
                    <label
                      htmlFor="disable-code"
                      className="block text-sm font-medium text-foreground"
                    >
                      {t('codeLabel')}
                    </label>
                    <Input
                      id="disable-code"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      autoFocus
                      required
                      value={disableCode}
                      onChange={e => setDisableCode(e.target.value)}
                      className="mt-1 text-center tracking-widest"
                      placeholder={t('codePlaceholder')}
                      maxLength={6}
                    />
                  </div>
                  <div className="flex gap-3">
                    <Button
                      type="button"
                      variant="outline"
                      className="flex-1"
                      onClick={() => {
                        setStep('idle');
                        setDisableCode('');
                        setDisableError('');
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="submit"
                      variant="destructive"
                      className="flex-1"
                      disabled={isSubmitting || disableCode.length !== 6}
                    >
                      {isSubmitting ? t('disabling') : t('disableButton')}
                    </Button>
                  </div>
                </form>
              </div>
            )}

            {/* ── Idle: show status + actions ──────────────────────────────────── */}
            {step === 'idle' && (
              <div className="rounded-2xl border border-border bg-card divide-y divide-border">
                {/* Status row */}
                <div className="flex items-center gap-4 p-5">
                  <div
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${status?.mfaEnabled ? 'bg-success/10 text-success dark:bg-success/15' : 'bg-muted text-muted-foreground'}`}
                  >
                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      {status?.mfaEnabled ? (
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"
                        />
                      ) : (
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
                        />
                      )}
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-foreground">
                      {status?.mfaEnabled ? t('statusEnabled') : t('statusDisabled')}
                    </p>
                    {status?.mfaEnabled && status.mfaEnrolledAt && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {new Date(status.mfaEnrolledAt).toLocaleDateString(undefined, {
                          year: 'numeric',
                          month: 'long',
                          day: 'numeric',
                        })}
                      </p>
                    )}
                  </div>
                  <div
                    className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                      status?.mfaEnabled
                        ? 'bg-success/10 text-success dark:bg-success/15'
                        : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {status?.mfaEnabled ? 'ON' : 'OFF'}
                  </div>
                </div>

                {/* Enable / Re-enroll row */}
                {!status?.mfaEnabled ? (
                  <div className="flex items-center justify-between gap-4 p-5">
                    <div className="min-w-0">
                      <p className="font-medium text-foreground">{t('enableTitle')}</p>
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        {t('enableDescription')}
                      </p>
                    </div>
                    <Button
                      type="button"
                      onClick={handleBeginEnroll}
                      disabled={isSubmitting}
                      className="shrink-0"
                    >
                      {t('beginButton')}
                    </Button>
                  </div>
                ) : (
                  <>
                    {/* Re-enroll while enabled: need current TOTP code first */}
                    <div className="p-5 space-y-3">
                      <div>
                        <p className="font-medium text-foreground">{t('reEnrollButton')}</p>
                        <p className="mt-0.5 text-sm text-muted-foreground">
                          {t('currentCodeLabel')}
                        </p>
                      </div>
                      {enrollError && step === 'idle' && (
                        <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                          {enrollError}
                        </div>
                      )}
                      <div className="flex gap-3">
                        <Input
                          type="text"
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          value={currentCode}
                          onChange={e => setCurrentCode(e.target.value)}
                          className="text-center tracking-widest"
                          placeholder={t('codePlaceholder')}
                          maxLength={6}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          onClick={handleBeginEnroll}
                          disabled={isSubmitting || currentCode.length !== 6}
                        >
                          {isSubmitting ? '…' : 'Continue'}
                        </Button>
                      </div>
                    </div>

                    {/* Disable row */}
                    <div className="flex items-center justify-between gap-4 p-5">
                      <div className="min-w-0">
                        <p className="font-medium text-foreground">{t('disableTitle')}</p>
                        <p className="mt-0.5 text-sm text-muted-foreground">
                          {t('disableDescription')}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="destructive"
                        onClick={() => {
                          setStep('disabling');
                          setDisableCode('');
                          setDisableError('');
                        }}
                        className="shrink-0"
                      >
                        {t('disableButton')}
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </AdminLayout>
  );
}
