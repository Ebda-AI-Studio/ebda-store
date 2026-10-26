import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import { Footer } from '@/components/Footer';
import { Header } from '@/components/Header';
import { Phone } from '@/components/Devices';
import { NotFoundLang } from '@/components/NotFoundLang';
import { RootShell } from '@/components/RootShell';
import { BRAND } from '@ebda/shared/brand';
import { NOT_FOUND, SEARCH_SOURCES } from '@/lib/not-found-copy';
import { LOCALES, demoLookUrl, type Locale } from '@/lib/site';

export const metadata: Metadata = {
  title: 'الصفحة مش موجودة | ابدأ استوديو للذكاء الاصطناعي',
  robots: { index: false, follow: true },
  icons: { icon: '/icon.svg', apple: '/apple-touch-icon.png' },
};
export const viewport: Viewport = { themeColor: '#FAFAFA', colorScheme: 'light dark' };

/** One static 404.html serves every path: show the language of the URL (/en/...), Arabic otherwise. */
// Only <html> attributes change before hydration (never React-owned text or elements), so hydration stays clean;
// the CSS (`html[data-nf]`) shows the matching language block.
const PICK_LANG = `(function(){var en=/^\\/en(\\/|$)/.test(location.pathname);var d=document.documentElement;
d.setAttribute('data-nf',en?'en':'ar');if(en){d.lang='en';d.dir='ltr';}})();`;

function Body({ locale }: { locale: Locale }) {
  const c = NOT_FOUND[locale];
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const id = `q-${locale}`;
  return (
    <div data-l={locale} lang={locale} dir={dir} className="nf-body">
      <div className="nf-main">
        <h1>{c.line}</h1>
        <p className="lead">{c.hint}</p>
        <form
          className="search nf-search"
          role="search"
          action={`https://${BRAND.domains.help}${locale === 'ar' ? '' : '/en'}/search/`}
          method="get"
          data-sources={JSON.stringify(SEARCH_SOURCES[locale])}
        >
          <label className="sr-only" htmlFor={id}>
            {c.searchLabel}
          </label>
          <input
            id={id}
            name="q"
            type="search"
            placeholder={c.searchPlaceholder}
            autoComplete="off"
            enterKeyHint="search"
          />
          <button type="submit">{c.searchButton}</button>
        </form>
      </div>
      <nav className="nf-map" aria-label={c.mapLabel}>
        {c.groups.map(g => (
          <div key={g.title}>
            <h2>{g.title}</h2>
            <ul>
              {g.links.map(l => (
                <li key={l.label}>
                  {l.soon ? (
                    <span className="nf-soon">
                      {l.label} <b>{c.soon}</b>
                    </span>
                  ) : (
                    <a href={l.href}>{l.label}</a>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <a className="nf-phone" href={demoLookUrl('souq', 'catalogue')} aria-label={c.phoneCaption}>
        <Phone className="nf-phone-frame">
          <picture>
            <source srcSet="/devices/dahab-story-4-900.avif" type="image/avif" />
            <source srcSet="/devices/dahab-story-4-900.webp" type="image/webp" />
            <img
              src="/devices/dahab-story-4-900.webp"
              alt=""
              width={900}
              height={1930}
              loading="lazy"
            />
          </picture>
        </Phone>
        <span>{c.phoneCaption}</span>
      </a>
    </div>
  );
}

/** 404 for every path (static export writes it to out/404.html): the Apple-style page, Arabic or English by URL. */
export default function NotFound() {
  return (
    <RootShell locale="ar">
      <Header locale="ar" offHome />
      <main id="main" className="wrap not-found">
        {LOCALES.map(l => (
          <Body key={l} locale={l} />
        ))}
        <script dangerouslySetInnerHTML={{ __html: PICK_LANG }} />
        <NotFoundLang />
        <Script src="/assets/typeahead.js" strategy="afterInteractive" />
      </main>
      <Footer locale="ar" />
    </RootShell>
  );
}
