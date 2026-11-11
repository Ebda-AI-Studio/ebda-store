'use client';

import { useState, useEffect, useCallback } from 'react';
import { Input, useToast } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { AdminLayout } from '../../../components/AdminLayout';
import { apiGet } from '../../../lib/api';
import {
  AccountsError,
  accountsFetch,
  accountsToken,
  establishApiSession,
} from '../../../lib/accounts';
import { useAuth } from '../../../lib/auth';
import { useT } from '@/i18n/useT';
import { withNumerals } from '@ebda/shared';
import { LegalAcceptancesPanel } from '../../../components/legal/LegalAcceptancesPanel';
import { PasskeysPanel } from '../../../components/account/PasskeysPanel';
import { PhonePanel } from '../../../components/account/PhonePanel';

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

// ── Identity-service calls ────────────────────────────────────────────────────

/**
 * MFA lives in the shared identity service (Rulings ID-1/ID-2). Each call gets a fresh 15 minute token, sends it as a Bearer
 * header, and returns the page's existing `{ data, error }` shape. After a change, the Store's own profile row is
 * reconciled at once (`/auth/session`), so the super-admin MFA gate sees it without waiting for the next refresh.
 */
async function acct<T>(
  path: string,
  json: unknown,
  syncStore = false
): Promise<{ data?: T; error?: { message: string; code: string } }> {
  try {
    const grant = await accountsToken();
    const data = await accountsFetch<T>(path, { json, bearer: grant.access_token });
    if (syncStore)
      await establishApiSession((await accountsToken()).access_token).catch(() => undefined);
    return { data };
  } catch (e) {
    if (e instanceof AccountsError) return { error: { message: e.message, code: e.code } };
    return { error: { message: String(e), code: 'REQUEST_FAILED' } };
  }
}

// ── Component ────────────────────────────────────────────────────────────────

export default function SecurityPage() {
  const t = useT('account.security');
  const tc = useT('common');
  const { user, logout } = useAuth();
  // A platform admin's FIRST factor ends every session (the password-only one included): sign in again with it.
  const [signInAgain, setSignInAgain] = useState(false);
  const { success: toastSuccess, error: toastError } = useToast();

  // Status
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [isLoadingStatus, setIsLoadingStatus] = useState(true);

  // Enroll flow
  const [step, setStep] = useState<Step>('idle');
  const [enrollData, setEnrollData] = useState<EnrollBeginData | null>(null);
  const [verifyCode, setVerifyCode] = useState('');
  // Platform administrators: the first factor needs the operator's one-time token plus a code e-mailed to the account.
  const [passkeyCount, setPasskeyCount] = useState<number | null>(null);
  // The server is the authority: when it asks for the e-mailed code the step is shown whatever the client guessed.
  const [serverWantsCode, setServerWantsCode] = useState(false);
  const [bootToken, setBootToken] = useState('');
  const [bootCode, setBootCode] = useState('');
  const [bootPassword, setBootPassword] = useState('');
  const [bootSent, setBootSent] = useState(false);
  const [password, setPassword] = useState(''); // step-up: the identity service asks for the password again
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
      const { data, error } = await acct<{ secret: string; otpauthUrl: string }>('/mfa/enroll', {
        password,
      });
      if (error) {
        setEnrollError(error.message || t('errorBegin'));
        return;
      }
      if (data) {
        const QRCode = (await import('qrcode')).default;
        setEnrollData({ secret: data.secret, qr: await QRCode.toDataURL(data.otpauthUrl) });
        setStep('enrolling');
        setVerifyCode('');
        setPassword('');
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleSendBootstrapCode() {
    setEnrollError('');
    setIsSubmitting(true);
    try {
      const { error } = await acct('/mfa/bootstrap/code', { password: bootPassword });
      if (error) {
        setEnrollError(error.message || t('errorVerify'));
        return;
      }
      setBootSent(true);
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
      const { data, error } = await acct<{ backupCodes: string[]; requiresSignIn?: boolean }>(
        '/mfa/enroll/verify',
        {
          code: verifyCode.trim(),
          // First factor of ANY account: a code e-mailed to it; a platform admin also needs the operator's token.
          ...(isFirstFactor ? { emailCode: bootCode.trim() } : {}),
          ...(isFirstAdminFactor ? { enrolmentToken: bootToken.trim() } : {}),
        },
        true
      );
      if (error) {
        if (error.code === 'EMAIL_CODE_REQUIRED' || error.code === 'EMAIL_CODE_INVALID')
          setServerWantsCode(true);
        setEnrollError(error.message || t('errorVerify'));
        setVerifyCode('');
        return;
      }
      setBackupCodes(data?.backupCodes ?? []);
      setSignInAgain(data?.requiresSignIn === true);
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
      const { error } = await acct('/mfa/disable', { password, code: disableCode.trim() }, true);
      if (error) {
        setDisableError(error.message || t('errorDisable'));
        setDisableCode('');
        return;
      }
      setStatus(prev => (prev ? { ...prev, mfaEnabled: false, mfaEnrolledAt: null } : prev));
      setStep('idle');
      setDisableCode('');
      setPassword('');
      toastSuccess(t('successDisabled'), undefined);
    } finally {
      setIsSubmitting(false);
    }
  }

  // A TOTP is a FIRST factor only when the account has neither a TOTP nor a passkey. A passkey alone is a complete
  // second-factor state for everyone, platform administrators included (it satisfies the second-factor requirement).
  const isFirstFactor = !status?.mfaEnabled && (serverWantsCode || passkeyCount === 0);
  const isFirstAdminFactor = user?.role === 'super_admin' && isFirstFactor;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')}>
      <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6 space-y-6">
        {/* Super-admin required banner */}
        {user?.role === 'super_admin' &&
          status &&
          !status.mfaEnabled &&
          passkeyCount === 0 &&
          step === 'idle' && (
            <div className="flex items-start gap-4 rounded-lg border border-warning/30 bg-warning/10 p-4">
              <svg
                className="mt-0.5 h-5 w-5 shrink-0 text-warning-ink"
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
                <p className="text-sm font-medium text-warning-ink">{t('mfaBanner')}</p>
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
          <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            {t('loading')}
          </div>
        ) : (
          <>
            {/* ── Backup codes display (after successful enroll) ──────────────── */}
            {step === 'backup' && (
              <div className="rounded-lg border border-border bg-card p-6 space-y-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-success/10 text-success-ink dark:bg-success/15">
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

                <div className="grid grid-cols-2 gap-2 rounded-md bg-muted/50 p-4 font-mono text-sm">
                  {backupCodes.map((code, i) => (
                    <span key={i} className="text-foreground">
                      {code}
                    </span>
                  ))}
                </div>

                {signInAgain && (
                  <p className="text-sm text-muted-foreground">{t('signInAgainAfterEnrol')}</p>
                )}
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
                      if (signInAgain) void logout();
                    }}
                  >
                    {signInAgain ? t('savedSignInAgainButton') : t('savedButton')}
                  </Button>
                </div>
              </div>
            )}

            {/* ── Enrollment flow ─────────────────────────────────────────────── */}
            {step === 'enrolling' && enrollData && (
              <div className="rounded-lg border border-border bg-card p-6 space-y-6">
                <div>
                  <h3 className="font-semibold text-foreground">{t('scanTitle')}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{t('scanDescription')}</p>
                </div>

                {/* QR code */}
                <div className="flex justify-center">
                  <img
                    src={enrollData.qr}
                    alt={t('qrCodeAlt')}
                    className="h-48 w-48 rounded-md border border-border"
                  />
                </div>

                {/* Manual key */}
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">{t('manualKey')}</p>
                  <code className="block w-full break-all rounded-lg bg-muted px-3 py-2 text-sm font-mono text-foreground">
                    {enrollData.secret}
                  </code>
                </div>

                {/* First factor: a code e-mailed to the account (a platform admin also needs the operator's token) */}
                {isFirstFactor && (
                  <div className="space-y-3 rounded-md border border-border p-4">
                    <p className="text-sm text-muted-foreground">{t('bootstrapIntro')}</p>
                    {isFirstAdminFactor && (
                      <div>
                        <label
                          htmlFor="boot-token"
                          className="block text-sm font-medium text-foreground"
                        >
                          {t('bootstrapTokenLabel')}
                        </label>
                        <Input
                          id="boot-token"
                          type="text"
                          dir="ltr"
                          autoComplete="off"
                          value={bootToken}
                          onChange={e => setBootToken(e.target.value)}
                          className="mt-1"
                        />
                      </div>
                    )}
                    <div className="flex items-end gap-2">
                      <div className="flex-1">
                        <label
                          htmlFor="boot-password"
                          className="block text-sm font-medium text-foreground"
                        >
                          {t('bootstrapPasswordLabel')}
                        </label>
                        <Input
                          id="boot-password"
                          type="password"
                          autoComplete="current-password"
                          value={bootPassword}
                          onChange={e => setBootPassword(e.target.value)}
                          className="mt-1"
                        />
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={isSubmitting || !bootPassword}
                        onClick={handleSendBootstrapCode}
                      >
                        {bootSent ? t('bootstrapResend') : t('bootstrapSend')}
                      </Button>
                    </div>
                    <div>
                      <label
                        htmlFor="boot-code"
                        className="block text-sm font-medium text-foreground"
                      >
                        {t('bootstrapCodeLabel')}
                      </label>
                      <Input
                        id="boot-code"
                        type="text"
                        inputMode="numeric"
                        dir="ltr"
                        autoComplete="off"
                        maxLength={6}
                        value={bootCode}
                        onChange={e => setBootCode(e.target.value)}
                        className="mt-1 text-center tracking-widest"
                      />
                    </div>
                  </div>
                )}

                {/* Verify form */}
                <form onSubmit={handleVerifyEnroll} className="space-y-4">
                  {enrollError && (
                    <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive-ink">
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
                      {tc('cancel')}
                    </Button>
                    <Button
                      type="submit"
                      className="flex-1"
                      disabled={
                        isSubmitting ||
                        verifyCode.length !== 6 ||
                        (isFirstFactor && bootCode.trim().length !== 6) ||
                        (isFirstAdminFactor && !bootToken.trim())
                      }
                    >
                      {isSubmitting ? t('verifying') : t('verifyButton')}
                    </Button>
                  </div>
                </form>
              </div>
            )}

            {/* ── Disable flow ─────────────────────────────────────────────────── */}
            {step === 'disabling' && (
              <div className="rounded-lg border border-destructive/30 bg-card p-6 space-y-4">
                <div>
                  <h3 className="font-semibold text-foreground">{t('disableConfirmTitle')}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t('disableConfirmDescription')}
                  </p>
                </div>
                <form onSubmit={handleDisable} className="space-y-4">
                  {disableError && (
                    <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive-ink">
                      {disableError}
                    </div>
                  )}
                  <div>
                    <label
                      htmlFor="disable-password"
                      className="block text-sm font-medium text-foreground"
                    >
                      {t('passwordLabel')}
                    </label>
                    <Input
                      id="disable-password"
                      type="password"
                      autoComplete="current-password"
                      required
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      className="mt-1"
                    />
                  </div>
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
                      {tc('cancel')}
                    </Button>
                    <Button
                      type="submit"
                      variant="destructive"
                      className="flex-1"
                      disabled={isSubmitting || disableCode.length !== 6 || !password}
                    >
                      {isSubmitting ? t('disabling') : t('disableButton')}
                    </Button>
                  </div>
                </form>
              </div>
            )}

            {/* ── Idle: show status + actions ──────────────────────────────────── */}
            {step === 'idle' && (
              <div className="rounded-lg border border-border bg-card divide-y divide-border">
                {/* Status row */}
                <div className="flex items-center gap-4 p-5">
                  <div
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${status?.mfaEnabled ? 'bg-success/10 text-success-ink dark:bg-success/15' : 'bg-muted text-muted-foreground'}`}
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
                        {new Date(status.mfaEnrolledAt).toLocaleDateString(
                          undefined,
                          withNumerals({
                            year: 'numeric',
                            month: 'long',
                            day: 'numeric',
                          })
                        )}
                      </p>
                    )}
                  </div>
                  <div
                    className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                      status?.mfaEnabled
                        ? 'bg-success/10 text-success-ink dark:bg-success/15'
                        : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {status?.mfaEnabled ? t('statusOn') : t('statusOff')}
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
                    <div className="flex shrink-0 items-center gap-3">
                      <Input
                        id="enroll-password"
                        type="password"
                        autoComplete="current-password"
                        aria-label={t('passwordLabel')}
                        placeholder={t('passwordLabel')}
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                      />
                      <Button
                        type="button"
                        onClick={handleBeginEnroll}
                        disabled={isSubmitting || !password}
                        className="shrink-0"
                      >
                        {t('beginButton')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
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
        {status && (
          <PasskeysPanel
            mfaEnabled={status.mfaEnabled}
            isAdmin={user?.role === 'super_admin'}
            onCount={setPasskeyCount}
            onSignInAgain={() => void logout()}
          />
        )}
        {status && <PhonePanel mfaEnabled={status.mfaEnabled} />}
        <LegalAcceptancesPanel />
      </div>
    </AdminLayout>
  );
}
