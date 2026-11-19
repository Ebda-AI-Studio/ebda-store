'use client';

import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { useAuth } from '@/lib/auth';

/**
 * A platform admin whose session carries no second-factor grant (Ruling ID-15: `pa` is minted only after a 2FA login within 12 h)
 * and who owns no store lands on /onboarding. They are not a merchant: say so, and offer a fresh sign-in (which asks for the second
 * factor) or sign out. Both end this session and land on the sign-in page; the store wizard is never shown to them.
 */
export function PlatformAdminGate() {
  const t = useT('onboarding.platformAdmin');
  const { logout } = useAuth();
  return (
    <div role="alert" className="space-y-4">
      <p className="text-sm leading-relaxed text-foreground">{t('body')}</p>
      <div className="flex flex-wrap gap-3">
        <Button type="button" onClick={() => void logout()}>
          {t('signInAgain')}
        </Button>
        <Button type="button" variant="outline" onClick={() => void logout()}>
          {t('signOut')}
        </Button>
      </div>
    </div>
  );
}
