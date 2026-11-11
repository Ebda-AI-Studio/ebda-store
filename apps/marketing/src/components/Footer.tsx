import { PageLink } from './PageLink';
import { siteFooter, type NavLink } from '@ebda/shared/brand';
import { SiteLink, NEW_TAB_NOTE } from './SiteLink';
import { CookieSettingsButton } from './CookieSettingsButton';
import { COPYRIGHT_YEAR } from '../lib/copyright-year';
import type { Locale, PageSlug } from '../lib/site';

/**
 * The ONE footer, identical on every marketing page and on help, docs and status: the brand column and four link
 * columns (Products, Resources, Studio, Legal), drawn from the brand module's `siteFooter` (which the support sites
 * render through `siteFooterHtml`; tests/unit/studio-nav-footer.test.ts keeps them equal). `page` is accepted for the
 * existing call sites and changes nothing: the footer no longer varies by product.
 */
export function Footer({ locale }: { locale: Locale; page?: PageSlug }) {
  const f = siteFooter(locale);
  const A = ({ l }: { l: NavLink }) =>
    l.path ? (
      <PageLink href={l.path}>{l.label}</PageLink>
    ) : (
      <SiteLink href={l.href} locale={locale}>
        {l.label}
      </SiteLink>
    );
  return (
    <footer className="site-footer band-dark sf">
      <div className="wrap">
        <div className="sf-grid">
          <div className="sf-brand">
            <p className="sf-name">
              <img src="/icon.svg" alt="" className="sf-mark" width={24} height={24} />
              <span>{f.brand.name}</span>
            </p>
            <p className="sf-mission">{f.brand.mission}</p>
            <dl className="sf-contact">
              {f.brand.contacts.map(c => (
                <div key={c.id}>
                  <dt>{c.label}</dt>
                  <dd>
                    <SiteLink
                      href={c.href}
                      locale={locale}
                      dir={c.id === 'whatsapp' ? 'ltr' : undefined}
                    >
                      {c.value}
                    </SiteLink>
                  </dd>
                </div>
              ))}
            </dl>
            <ul className="sf-social">
              {f.brand.social.map(s => (
                <li key={s.id}>
                  <a
                    href={s.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`${s.name} (${NEW_TAB_NOTE[locale]})`}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      width={20}
                      height={20}
                      aria-hidden="true"
                      focusable="false"
                    >
                      <path fill="currentColor" d={s.path} />
                    </svg>
                  </a>
                </li>
              ))}
            </ul>
          </div>
          {f.columns.map(col => (
            <nav key={col.id} className="sf-col" aria-labelledby={`sf-${col.id}`}>
              <h2 id={`sf-${col.id}`}>{col.title}</h2>
              <ul>
                {col.links.map(l => (
                  <li key={l.id}>
                    {l.action === 'cookies' ? (
                      <CookieSettingsButton label={l.label} />
                    ) : (
                      <A l={l} />
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <div className="sf-bottom">
          <p className="muted small">{f.copyright(COPYRIGHT_YEAR)}</p>
        </div>
      </div>
    </footer>
  );
}
