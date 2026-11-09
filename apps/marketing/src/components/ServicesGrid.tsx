import { serviceInfo } from '@ebda/shared/brand';
import type { Locale } from '../lib/site';

/** One small motif per card, cycling through the studio's quiet medallions (8-fold star, octagon ring, quatrefoil: never a hexagram). */
const MOTIFS = ['m8', 'mr', 'mq'] as const;

/**
 * What the studio does: the seven service categories of BRAND.services as a clean grid (the studio home and About), each
 * with its named sub-items. Benefit lines only. Wording is pending a match to the registration papers (see BRAND.services). Products (Ebda Store, Ebda Chat) are a separate section.
 */
export function ServicesGrid({ locale }: { locale: Locale }) {
  return (
    <ul className="svc-grid">
      {serviceInfo(locale).map((s, i) => (
        <li key={s.id} className={`svc svc-${MOTIFS[i % MOTIFS.length]}`} data-service={s.id}>
          <h3>{s.name}</h3>
          <p>{s.benefit}</p>
          {s.items.length > 0 && (
            <ul className="svc-items">
              {s.items.map(i => (
                <li key={i.id}>{i.name}</li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}
