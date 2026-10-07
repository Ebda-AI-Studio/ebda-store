import type { ReactNode } from 'react';
import { BRAND } from '@force/shared/brand';
import { DEMO_STORES, DEMO_UI, egp, type TemplateId } from '../lib/demo-stores';
import type { Locale } from '../lib/site';

/** Device frames drawn in CSS (bezel, glass, reflections); the screen content is real HTML. */
export function Phone({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`dev-phone ${className}`.trim()}>
      <div className="dev-screen">
        <span className="dev-island" />
        {children}
      </div>
    </div>
  );
}

export function Tablet({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`dev-tablet ${className}`.trim()}>
      <div className="dev-screen">{children}</div>
    </div>
  );
}

export function Laptop({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`dev-laptop ${className}`.trim()}>
      <div className="dev-lid">
        <div className="dev-screen">{children}</div>
      </div>
      <div className="dev-base" />
    </div>
  );
}

function Photo({ img, sizes }: { img: string; sizes: string }) {
  const set = (ext: string) => `/demo/${img}-240.${ext} 240w, /demo/${img}-480.${ext} 480w`;
  return (
    <picture>
      <source type="image/avif" srcSet={set('avif')} sizes={sizes} />
      <img
        src={`/demo/${img}-480.webp`}
        srcSet={set('webp')}
        sizes={sizes}
        width={480}
        height={480}
        alt=""
        loading="lazy"
        decoding="async"
      />
    </picture>
  );
}

/**
 * A storefront in one of the five template families. `palette` restyles it without
 * changing the products (used by the scroll story); the grid reflows by container width.
 */
export function DemoStore({
  tpl,
  locale,
  palette,
  sizes = '120px',
}: {
  tpl: TemplateId;
  locale: Locale;
  palette?: TemplateId;
  sizes?: string;
}) {
  const s = DEMO_STORES[tpl];
  const ui = DEMO_UI[locale];
  return (
    <div className="store" data-pal={palette ?? tpl} aria-hidden="true">
      <div className="store-in">
        <div className="st-url" dir="ltr">
          {tpl}
          {BRAND.domains.storeSuffix}
        </div>
        <div className="st-head st-logo">
          <span className="st-mark">{s.name[locale].charAt(0)}</span>
          <span className="st-name">{s.name[locale]}</span>
          <svg className="st-cart" viewBox="0 0 24 24" width="16" height="16">
            <path
              d="M3 4h2l2.4 11h10.2L20 7H6.2M9 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm8 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <div className="st-hero st-logo">
          <p>{s.tagline[locale]}</p>
          <span className="st-btn">{ui.shop}</span>
        </div>
        <p className="st-sec">{ui.bestsellers}</p>
        <ul className="st-grid">
          {s.products.map((p, i) => (
            <li key={p.img} style={{ '--i': i } as React.CSSProperties}>
              <span className="st-img">
                <Photo img={p.img} sizes={sizes} />
              </span>
              <span className="st-pname">{p.name[locale]}</span>
              <span className="st-price">{egp(locale, p.price)}</span>
            </li>
          ))}
        </ul>
        <div className="st-bar">
          <span className="st-cod">{ui.cod}</span>
          <span className="st-wa">{ui.order}</span>
        </div>
      </div>
    </div>
  );
}
