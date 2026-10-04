'use client';

import { PublicShell } from '../../components/onboarding/PublicShell';
import { useT } from '@/i18n/useT';
import { OnboardingFlow } from './_components/OnboardingFlow';

export default function OnboardingPage() {
  const t = useT('onboarding.flow');
  return (
    <PublicShell title={t('title')} wide>
      <OnboardingFlow />
    </PublicShell>
  );
}
