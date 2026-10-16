'use client';

/**
 * The footer's WhatsApp contact line (S-02, quality-bar § 8): "واتساب 010…",
 * a labelled wa.me link in each footer's contact column (5 skins + Dahab), so the
 * channel Egyptian shoppers use most is named, not only an unlabelled icon in the
 * social row. The number is the store's own `contact.whatsapp`, normalised by
 * `waMeLink` (local 01x → 201x); no valid number = nothing renders.
 */
import { waMeLink } from '@ebda/shared';
import { useLanguage } from '../../contexts/LanguageContext';
import { WhatsappGlyphIcon } from './icons';

export function FooterWhatsApp({
  whatsapp,
  className,
}: {
  whatsapp?: string | null;
  className?: string;
}) {
  const { t } = useLanguage();
  const href = waMeLink(whatsapp);
  if (!href || !whatsapp) return null;
  return (
    <a
      data-footer-whatsapp=""
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={['inline-flex items-center gap-2', className].filter(Boolean).join(' ')}
    >
      <WhatsappGlyphIcon className="h-4 w-4 shrink-0" fill="currentColor" />
      <span>{t('WhatsApp', 'واتساب')}</span>
      <bdi dir="ltr">{whatsapp.trim()}</bdi>
    </a>
  );
}
