'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { PublicShell } from '../../components/onboarding/PublicShell';
import { apiPost } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useT } from '@/i18n/useT';

const KEY = 'ebda-staff-invite';

type Phase =
  | { kind: 'working' }
  | { kind: 'done'; requiresSignIn: boolean }
  | {
      kind: 'error';
      reason:
        | 'missing'
        | 'invalid'
        | 'mismatch'
        | 'notVerified'
        | 'ownsStore'
        | 'limit'
        | 'generic';
    };

const REASONS: Record<string, 'invalid' | 'mismatch' | 'notVerified' | 'ownsStore' | 'limit'> = {
  INVITE_INVALID: 'invalid',
  INVITE_EMAIL_MISMATCH: 'mismatch',
  EMAIL_NOT_VERIFIED: 'notVerified',
  OWNS_STORE: 'ownsStore',
  PLAN_LIMIT_REACHED: 'limit',
};

/**
 * Explicit accept step for a staff invitation sent to an EXISTING account (Ruling ID-13). The token rides in the URL
 * fragment (never sent to a server or logged), is parked in sessionStorage across the sign-in redirect, and is redeemed
 * only once the visitor is signed in. Nothing about the account changes before this page does it.
 */
export default function AcceptInvitePage() {
  const t = useT('onboarding.acceptInvite');
  const router = useRouter();
  const { isAuthenticated, isLoading } = useAuth();
  const [phase, setPhase] = useState<Phase>({ kind: 'working' });
  const redeemed = useRef(false);

  // Park the token first, before anything can navigate away or record the address.
  useEffect(() => {
    const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
    if (fromHash) {
      try {
        sessionStorage.setItem(KEY, fromHash);
      } catch {
        /* private mode: the fragment is lost on the sign-in redirect and the visitor reopens the link */
      }
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  useEffect(() => {
    if (isLoading || !isAuthenticated || redeemed.current) return;
    let token: string | null = null;
    try {
      token = sessionStorage.getItem(KEY);
    } catch {
      token = null;
    }
    if (!token) {
      setPhase({ kind: 'error', reason: 'missing' });
      return;
    }
    redeemed.current = true;
    void (async () => {
      const { data, error } = await apiPost<{ requiresSignIn: boolean }>(
        '/api/v1/staff-invites/accept',
        { token }
      );
      if (error) {
        setPhase({ kind: 'error', reason: REASONS[error.code] ?? 'generic' });
        return;
      }
      try {
        sessionStorage.removeItem(KEY);
      } catch {
        /* nothing to clean */
      }
      setPhase({ kind: 'done', requiresSignIn: !!data?.requiresSignIn });
    })();
  }, [isLoading, isAuthenticated]);

  if (phase.kind === 'working') {
    return (
      <PublicShell title={t('title')} subtitle={t('working')}>
        <div role="status" className="flex justify-center py-4">
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      </PublicShell>
    );
  }

  if (phase.kind === 'done') {
    return phase.requiresSignIn ? (
      <PublicShell title={t('signInAgainTitle')} subtitle={t('signInAgainBody')}>
        <Button type="button" className="w-full" onClick={() => router.push('/login')}>
          {t('signIn')}
        </Button>
      </PublicShell>
    ) : (
      <PublicShell title={t('successTitle')} subtitle={t('successBody')}>
        <Button type="button" className="w-full" onClick={() => router.push('/dashboard')}>
          {t('continue')}
        </Button>
      </PublicShell>
    );
  }

  return (
    <PublicShell title={t('title')} subtitle={t(phase.reason)}>
      <Button type="button" className="w-full" onClick={() => router.push('/login')}>
        {t('signIn')}
      </Button>
    </PublicShell>
  );
}
