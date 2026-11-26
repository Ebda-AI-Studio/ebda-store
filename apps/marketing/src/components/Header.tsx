import { PageLink } from './PageLink';
import {
  SITE_NAV_ICONS,
  productBar,
  siteNavCta,
  siteNavLabels,
  siteNavLogin,
  siteNavProducts,
  siteNavServices,
  siteNavResources,
  siteNavStudio,
  studioHomeLink,
  type NavLink,
  type SiteNavProductId,
} from '@ebda/shared/brand';
import { COPY } from '../lib/content';
import { serviceLinesPublished } from '../lib/service-lines';
import { SERVICES_PAGE } from '../lib/services-page';
import { comingSoonItems, comingSoonLabels } from '../lib/coming-soon';
import { NavBehavior } from './NavBehavior';
import { SiteLink } from './SiteLink';
import { WhatsApp } from './WhatsApp';
import { HeaderSearch } from './HeaderSearch';
import { absoluteUrl, productOfPage, pagePath, type Locale, type PageSlug } from '../lib/site';

type Page = PageSlug;

/**
 * One link of the shared nav data (packages/shared/src/brand): a marketing page routes client-side through PageLink (a file path such as security.txt is a plain anchor),
 * everything else (help, docs, status, the apps) is a plain anchor. Product-app links stay in the same tab.
 */
function NavA({
  l,
  locale,
  current = false,
  className,
}: {
  l: NavLink;
  locale: Locale;
  current?: boolean;
  className?: string;
}) {
  const aria = current ? ({ 'aria-current': 'page' } as const) : {};
  return l.path ? (
    <PageLink href={l.path} className={className} {...aria}>
      {l.label}
    </PageLink>
  ) : (
    <SiteLink href={l.href} locale={locale} className={className} {...aria}>
      {l.label}
    </SiteLink>
  );
}

/** The product icon (shared paths from the brand module, so docs/help/status draw the same one). */
function ProductIcon({ id, mirror = false }: { id: SiteNavProductId; mirror?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      aria-hidden="true"
      focusable="false"
      style={mirror ? { transform: 'scaleX(-1)' } : undefined}
    >
      {SITE_NAV_ICONS[id].map(p =>
        p.fill ? (
          <path key={p.d} d={p.d} fill="currentColor" />
        ) : (
          <path
            key={p.d}
            d={p.d}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )
      )}
    </svg>
  );
}

/**
 * The ONE header (public sites audit 2026-11-03, section 4): the studio bar on every page (wordmark to the studio home,
 * Products, Resources, About, Contact, language, Log in, the studio CTA) and, only on a product page, the product bar
 * under it. Its data is the brand module's (`siteNav*`, `productBar`), the same that docs, help and status render.
 * `offHome` is kept for the 404 call site: every link is absolute now, so it changes nothing.
 *
 * The CTA: "Choose a product" (Ruling NAV-CTA-1) everywhere except a service page, where it asks for the conversation
 * and opens the contact form with that service preselected (Ruling NAV-CTA-2). In the Menu the CTA and WhatsApp are one
 * block, the LAST item, pinned to the panel's bottom edge by CSS (chrome.css, Ruling NAV-MENU-ACTIONS-1). Which items
 * sit in the bar and which in the Menu at each width is CSS too (chrome.css, Ruling NAV-BAR-FIT-1): both are rendered.
 */
export function Header({ locale, page = '' }: { locale: Locale; page?: Page; offHome?: boolean }) {
  const c = COPY[locale];
  const lang = locale;
  const other: Locale = locale === 'ar' ? 'en' : 'ar';
  const kind = productOfPage(page);
  const home = studioHomeLink(lang);
  const t = siteNavLabels(lang);
  const products = siteNavProducts(lang);
  const resources = siteNavResources(lang);
  const studio = siteNavStudio(lang);
  const login = siteNavLogin(lang, kind);
  const cta = siteNavCta(lang);
  const bar = kind === 'studio' ? null : productBar(kind, lang);
  const here = pagePath(locale, page).replace(/\/?$/, '/');
  const cur = (l: NavLink) => !!l.path && l.path === here;
  // Services dropdown + coming-soon Products items (SERVICES-IA-1): present only when the service lines are published
  // (build flag EBDA_SERVICE_LINES=on); when off, both are absent and the header is exactly the studio's.
  const services = serviceLinesPublished() ? siteNavServices(lang) : null;
  const servicesLabel = SERVICES_PAGE[locale].nav;
  const soon = comingSoonItems(locale);
  const soonLabel = comingSoonLabels(locale).label;
  const svcHere = page === 'services' || page.startsWith('services/');
  const svcCur = (l: NavLink) =>
    l.id === 'all' ? page === 'services' : l.id === 'core' ? false : page === `services/${l.id}`;
  // A service page asks for the conversation, not for a product (Ruling NAV-CTA-2): the same link as the page's own
  // hero button, so the contact form opens with this service preselected. The label is the short one: the hero says
  // the full sentence, the bar has room for two words.
  const line = page.startsWith('services/') ? page.slice('services/'.length) : '';
  const contact = `${line ? `?topic=${line}` : ''}#form`;
  const primary: NavLink =
    services && svcHere
      ? {
          id: 'cta',
          label: SERVICES_PAGE[locale].headerCta,
          path: `${pagePath(locale, 'contact')}/${contact}`,
          href: `${absoluteUrl(pagePath(locale, 'contact'))}${contact}`,
        }
      : cta;
  return (
    <header className="site-header">
      <div className="wrap header-row">
        <PageLink href={home.path!} className="wordmark" aria-label={home.label}>
          <img src="/icon.svg" alt="" width={28} height={28} />
          <span className="wm-name">{home.label}</span>
        </PageLink>
        <nav aria-label={t.nav} className="nav">
          <ul className="nav-links">
            <li className="nav-products">
              <details>
                <summary>{t.products}</summary>
                <ul>
                  {products.map(p => (
                    <li key={p.id}>
                      <PageLink href={p.path!}>
                        <span className="np-ico">
                          <ProductIcon id={p.id} mirror={locale === 'ar' && p.id === 'whatsapp'} />
                        </span>
                        <span className="np-txt">
                          <b>{p.label}</b>
                          <span>{p.blurb}</span>
                        </span>
                      </PageLink>
                    </li>
                  ))}
                  {soon.map(it => (
                    <li key={it.id} className="np-soon" data-coming-soon={it.id}>
                      <span className="np-txt">
                        <b>
                          {it.name} <em className="np-badge">{soonLabel}</em>
                        </b>
                        <span>{it.short}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            </li>
            {services && (
              <li className="nav-products nav-services">
                <details>
                  <summary aria-current={svcHere ? 'page' : undefined}>{servicesLabel}</summary>
                  <ul>
                    {services.map(sv => (
                      <li key={sv.id}>
                        <PageLink href={sv.path!} aria-current={svcCur(sv) ? 'page' : undefined}>
                          <span className="np-txt">
                            <b>{sv.label}</b>
                            <span>{sv.blurb}</span>
                          </span>
                        </PageLink>
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            )}
            <li className="nav-products">
              <details>
                <summary>{t.resources}</summary>
                <ul>
                  {resources.map(r => (
                    <li key={r.id}>
                      <NavA locale={locale} l={r} />
                    </li>
                  ))}
                </ul>
              </details>
            </li>
            {studio.map(s => (
              <li key={s.id}>
                <NavA locale={locale} l={s} current={cur(s)} />
              </li>
            ))}
          </ul>
          <details className="nav-menu">
            <summary>
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <path
                  d="M4 7h16M4 12h16M4 17h16"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  fill="none"
                />
              </svg>
              <span className="menu-label">{t.menu}</span>
            </summary>
            <ul>
              <li className="menu-group">
                <p>{t.products}</p>
                <ul>
                  {products.map(p => (
                    <li key={p.id}>
                      <NavA locale={locale} l={p} />
                    </li>
                  ))}
                  {soon.map(it => (
                    <li key={it.id} className="np-soon" data-coming-soon={it.id}>
                      <span>
                        {it.name} <em className="np-badge">{soonLabel}</em>
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
              {services && (
                <li className="menu-group">
                  <p>{servicesLabel}</p>
                  <ul>
                    {services.map(sv => (
                      <li key={sv.id}>
                        <NavA locale={locale} l={sv} current={svcCur(sv)} />
                      </li>
                    ))}
                  </ul>
                </li>
              )}
              <li className="menu-group">
                <p>{t.resources}</p>
                <ul>
                  {resources.map(r => (
                    <li key={r.id}>
                      <NavA locale={locale} l={r} />
                    </li>
                  ))}
                </ul>
              </li>
              <li className="menu-group">
                <p>{t.studio}</p>
                <ul>
                  {studio.map(s => (
                    <li key={s.id}>
                      <NavA locale={locale} l={s} current={cur(s)} />
                    </li>
                  ))}
                </ul>
              </li>
              <li className="menu-group menu-login">
                <p>{login.label}</p>
                <ul>
                  {login.items.map(i => (
                    <li key={i.id}>
                      <NavA locale={locale} l={i} />
                    </li>
                  ))}
                </ul>
              </li>
              <li className="menu-lang">
                <a href={pagePath(other, page)} hrefLang={other} lang={other}>
                  {c.nav.switchTo}
                </a>
              </li>
              <li className="menu-actions">
                <NavA locale={locale} l={bar ? bar.cta : primary} className="nav-cta menu-start" />
                <WhatsApp label={c.whatsapp.label} ariaLabel={c.whatsapp.aria} locale={locale} />
              </li>
            </ul>
          </details>
        </nav>
        <div className="header-actions">
          <HeaderSearch locale={locale} />
          {/* Plain anchor on purpose (LANG-SWITCH-1): a locale change swaps <html lang/dir>, fonts and metadata, so it is
              always a full document load and never depends on the client router (RSC fetch / prefetch cache). */}
          <a
            href={pagePath(other, page)}
            hrefLang={other}
            lang={other}
            className="lang-toggle"
            aria-label={c.nav.switchLabel}
          >
            {c.nav.switchTo}
          </a>
          {login.items.length === 1 ? (
            <NavA
              locale={locale}
              l={{ ...login.items[0], label: login.label }}
              className="link-login"
            />
          ) : (
            <div className="nav-products login-menu">
              <details>
                <summary>{login.label}</summary>
                <ul>
                  {login.items.map(i => (
                    <li key={i.id}>
                      <NavA locale={locale} l={i} />
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          )}
          <WhatsApp label={c.whatsapp.label} ariaLabel={c.whatsapp.aria} locale={locale} compact />
          {!bar && <NavA locale={locale} l={primary} className="btn btn-primary header-start" />}
        </div>
      </div>
      {bar && (
        <div className="product-bar">
          <div className="wrap product-row">
            <PageLink
              href={bar.chip.path!}
              className="product-chip"
              aria-current={cur(bar.chip) ? 'page' : undefined}
            >
              {bar.chip.label}
            </PageLink>
            <ul className="product-links">
              {bar.links.map(l => (
                <li key={l.id}>
                  <NavA locale={locale} l={l} current={cur(l)} />
                </li>
              ))}
            </ul>
            <NavA locale={locale} l={bar.cta} className="btn btn-primary btn-sm product-cta" />
          </div>
        </div>
      )}
      <NavBehavior />
    </header>
  );
}
