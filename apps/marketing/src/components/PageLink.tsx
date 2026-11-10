import Link from 'next/link';
import type { AnchorHTMLAttributes } from 'react';

/**
 * True when `href` is a page of this site the client router can handle: a root-relative path whose last segment has
 * no file extension. A file (`/.well-known/security.txt`, `/sitemap.xml`, `/llms.txt`, an image, a PDF), another
 * origin, `mailto:`/`tel:` and anything not starting with one `/` are NOT pages: through Next's <Link> with
 * `trailingSlash: true` the router rewrote `/.well-known/security.txt` to `/.well-known/security/`, a 404.
 */
export function isPagePath(href: string): boolean {
  if (!href.startsWith('/') || href.startsWith('//')) return false;
  const path = href.split(/[?#]/)[0];
  const last = path.slice(path.lastIndexOf('/') + 1);
  return !/\.[a-z0-9]+$/i.test(last);
}

type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { href: string };

/**
 * The ONE same-site link of the marketing app (eslint bans `next/link` everywhere else): a page goes through the
 * client router, anything else is a plain anchor (a full page load).
 */
export function PageLink({ href, ...rest }: Props) {
  if (isPagePath(href)) return <Link href={href} {...rest} />;
  return <a href={href} {...rest} />;
}
