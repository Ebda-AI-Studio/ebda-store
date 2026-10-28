'use client';

import NextLink from 'next/link';
import { forwardRef, type ComponentProps } from 'react';
import { useLocalePath } from '../contexts/LocalePathContext';
import { localizeHref } from '../lib/locale-paths';

type Props = ComponentProps<typeof NextLink>;

/**
 * The storefront's one `Link` (LOCALE-PATHS-1). On a `/ar|/en` page of a store that has language-in-the-URL ON, an internal
 * link to an indexable route carries the page's language prefix, so a click is not an extra 301; everywhere else it is
 * `next/link` unchanged. EVERY storefront component imports `Link` from here, never from `next/link`
 * (tests/unit/web-locale-paths-links.test.ts fails on a direct import).
 */
export const StoreLink = forwardRef<HTMLAnchorElement, Props>(function StoreLink(
  { href, ...rest },
  ref
) {
  const locale = useLocalePath();
  const localized =
    typeof href === 'string'
      ? localizeHref(href, locale)
      : href.pathname
        ? { ...href, pathname: localizeHref(href.pathname, locale) }
        : href;
  return <NextLink ref={ref} href={localized} {...rest} />;
});

export default StoreLink;

/** A hook for the programmatic navigations (`router.push`, `window.location`): the href as the page's language wants it. */
export function useLocalizedHref(): (href: string) => string {
  const locale = useLocalePath();
  return (href: string) => localizeHref(href, locale);
}

/**
 * A plain `<a>` whose internal href carries the page's language prefix (LOCALE-PATHS-1), for the few places that need an
 * anchor and not a client-routed link (no prefetch). Same rule as `StoreLink`; external, `mailto:`, `tel:` and `#hash` pass through.
 */
export function StoreAnchor({ href, ...rest }: ComponentProps<'a'>) {
  const locale = useLocalePath();
  return <a href={typeof href === 'string' ? localizeHref(href, locale) : href} {...rest} />;
}
