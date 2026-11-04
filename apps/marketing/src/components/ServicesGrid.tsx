import { serviceInfo } from '@ebda/shared/brand';
import type { Locale } from '../lib/site';

/** One small motif per card, cycling through the studio's quiet medallions (8-fold star, octagon ring, quatrefoil: never a hexagram). */
const MOTIFS = ['m8', 'mr', 'mq'] as const;

/**
 * What the studio does: the seven services of BRAND.services as a clean grid (the studio home and About). Benefit lines
 * only. Products (Ebda Store, Ebda Chat) are a separate section.
 */
export function ServicesGrid({ locale }: { locale: Locale }) {
  return (
    <ul className="svc-grid">
      {serviceInfo(locale).map((s, i) => (
        <li key={s.id} className={`svc svc-${MOTIFS[i % MOTIFS.length]}`} data-service={s.id}>
          <h3>{s.name}</h3>
          <p>{s.benefit}</p>
        </li>
      ))}
    </ul>
  );
}
