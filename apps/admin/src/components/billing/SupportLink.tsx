'use client';

import { useT } from '../../i18n/useT';

/**
 * How a merchant reaches Ebda about billing: the WhatsApp link when support
 * WhatsApp is configured, otherwise the support email. Never an empty wa.me
 * link (Ruling EBDA-BILLFU-2).
 */
export function SupportLink({
  whatsappUrl,
  email,
  className = 'font-medium underline',
}: {
  whatsappUrl: string | null | undefined;
  email: string | null | undefined;
  className?: string;
}) {
  const t = useT('billing.notice');
  if (whatsappUrl) {
    return (
      <a href={whatsappUrl} target="_blank" rel="noreferrer" className={className}>
        {t('whatsapp')}
      </a>
    );
  }
  if (!email) return null;
  return (
    <a href={`mailto:${email}`} className={className}>
      {t('email', { email })}
    </a>
  );
}
