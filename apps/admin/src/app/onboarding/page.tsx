'use client';

import { PublicShell } from '../../components/onboarding/PublicShell';
import { useT } from '@/i18n/useT';
import { useAuth } from '@/lib/auth';
import { OnboardingFlow } from './_components/OnboardingFlow';
import { PlatformAdminGate } from './_components/PlatformAdminGate';

export default function OnboardingPage() {
  const t = useT('onboarding.flow');
  const tp = useT('onboarding.platformAdmin');
  const { user } = useAuth();
  // A platform admin is never a merchant: no store wizard, only the way back in with two-step verification.
  if (user?.role === 'super_admin') {
    return (
      <PublicShell title={tp('title')} wide>
        <PlatformAdminGate />
      </PublicShell>
    );
  }
  return (
    <PublicShell title={t('title')} wide>
      <OnboardingFlow />
    </PublicShell>
  );
}
