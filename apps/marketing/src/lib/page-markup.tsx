import { createHash } from 'node:crypto';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AboutPage } from '../components/AboutPage';
import { ComparePage } from '../components/ComparePage';
import { ContactPage } from '../components/ContactPage';
import { CreditsPage } from '../components/CreditsPage';
import { FeaturesPage } from '../components/FeaturesPage';
import { Home } from '../components/Home';
import { StudioHomePage } from '../components/StudioHome';
import { WhatsAppPage } from '../components/WhatsAppPage';
import {
  COMPARE_PAGES,
  FOR_PAGES,
  LOCALES,
  type CompareSlug,
  type ForSlug,
  type Locale,
  type PageSlug,
} from './site';
import { VerticalPage } from '../components/VerticalPage';

/**
 * What the sitemap's <lastmod> is tied to: the rendered markup of each non-legal page (both locales). Legal pages
 * carry their own published date (LEGAL_UPDATED). `npm run lastmod -w apps/marketing` re-hashes and re-dates only the
 * pages whose markup changed; tests/unit/marketing-page-lastmod.test.tsx fails until you do, so lastmod is never
 * a build time and never a stale hand-edited constant.
 */
export const DATED_PAGES: readonly PageSlug[] = [
  '',
  'store',
  'features',
  'whatsapp',
  ...COMPARE_PAGES,
  ...FOR_PAGES,
  'about',
  'contact',
  'credits',
];

const render = (page: PageSlug, locale: Locale): ReactElement => {
  if (page === '') return <StudioHomePage locale={locale} />;
  if (page === 'store') return <Home locale={locale} />;
  if (page === 'features') return <FeaturesPage locale={locale} />;
  if (page === 'whatsapp') return <WhatsAppPage locale={locale} />;
  if (page === 'about') return <AboutPage locale={locale} />;
  if (page === 'contact') return <ContactPage locale={locale} />;
  if (page === 'credits') return <CreditsPage locale={locale} />;
  if (page.startsWith('for/'))
    return <VerticalPage locale={locale} slug={page.split('/')[1] as ForSlug} />;
  if (page.startsWith('compare/'))
    return <ComparePage locale={locale} slug={page.split('/')[1] as CompareSlug} />;
  throw new Error(`no renderer for ${page}`);
};

export function pageHash(page: PageSlug): string {
  const h = createHash('sha256');
  for (const l of LOCALES) h.update(renderToStaticMarkup(render(page, l)));
  return h.digest('hex').slice(0, 16);
}
