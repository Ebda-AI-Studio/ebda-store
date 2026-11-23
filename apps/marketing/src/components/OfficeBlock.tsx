import { officeInfo } from '@ebda/shared/brand';
import type { Locale } from '../lib/site';
import { SiteLink } from './SiteLink';
import '@/app/about.css';

const COPY = {
  ar: { address: 'العنوان', map: 'افتح الموقع على الخريطة' },
  en: { address: 'Address', map: 'Open on the map' },
} as const;

/**
 * The studio's office, from BRAND.office (one source): the address, the map link and how we meet. A virtual office:
 * the meeting line says online first and in-person by appointment only, and nothing here implies walk-in hours.
 */
export function OfficeBlock({ locale, headingId }: { locale: Locale; headingId?: string }) {
  const o = officeInfo(locale);
  const t = COPY[locale];
  return (
    <div className="office">
      <h3 id={headingId}>{t.address}</h3>
      <address>{o.address}</address>
      <p>
        <SiteLink href={o.mapUrl} locale={locale}>
          {t.map}
        </SiteLink>
      </p>
      <p className="muted">{o.meeting}</p>
    </div>
  );
}
