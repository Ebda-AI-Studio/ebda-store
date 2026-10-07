import { BRAND } from '../brand';
import { isReservedSlug } from './reserved-slugs';
import { validateStoreSlugFormat } from './slug';

/** Platform surfaces (never a store) that live on, or in front of, a host. */
export type PlatformApp =
  | 'marketing'
  | 'admin'
  | 'api'
  | 'orders'
  | 'docs'
  | 'help'
  | 'status'
  | 'whatsapp'
  | 'preview';

/**
 * What a request `Host` is for.
 *
 *  - `subdomain` — a store's free address, `<slug>.ebda.app`.
 *  - `custom`    — anything else that is a well-formed public hostname: a merchant
 *                  custom domain candidate. The resolver still has to find it in the
 *                  database; a miss is a 404.
 *  - `platform`  — one of OUR hosts (apex, app., api., …) or a hosting-provider
 *                  preview host. These never render a store.
 *  - `invalid`   — empty, malformed, an IP, `localhost`, a reserved label that has no
 *                  platform surface, or a multi-label name under `.ebda.app`. 404.
 */
export type ParsedStoreHost =
  | { kind: 'subdomain'; slug: string }
  | { kind: 'custom'; hostname: string }
  | { kind: 'platform'; app: PlatformApp }
  | { kind: 'invalid' };

export interface ParseStoreHostOptions {
  /**
   * Accept `<slug>.ebda.localhost` and `<slug>.localhost` as store subdomains.
   * LOCAL DEV ONLY: callers pass `process.env.NODE_ENV !== 'production'`. Off by
   * default so a production Host header can never reach a store this way.
   */
  allowDevSuffixes?: boolean;
}

/** Dev-only store suffixes (longest first so `.ebda.localhost` wins). */
export const DEV_STORE_SUFFIXES = ['.ebda.localhost', '.localhost'] as const;

/** Hosting-provider preview suffixes: any subdomain is a platform preview host. */
export const PREVIEW_HOST_SUFFIXES = [
  'workers.dev',
  'netlify.app',
  'ngrok.io',
  'ngrok-free.app',
] as const;

/** Reserved labels that front a real platform surface under `.ebda.app`. */
const PLATFORM_LABELS: Readonly<Record<string, PlatformApp>> = {
  admin: 'admin',
  api: 'api',
  orders: 'orders',
  docs: 'docs',
  help: 'help',
  status: 'status',
  whatsapp: 'whatsapp',
};

const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Lowercase, drop the port and a single trailing dot. Returns `null` for
 * anything that cannot be a DNS hostname (empty, whitespace, brackets/IPv6,
 * userinfo, paths, non-ASCII). Punycode (`xn--…`) is plain ASCII and passes.
 */
export function normalizeHost(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let host = raw.trim().toLowerCase();
  if (!host) return null;
  host = host.replace(/:\d{1,5}$/, '');
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (!host || host.length > 253) return null;
  // A remaining ':' means IPv6 / junk; brackets, '/', '@', spaces, non-ASCII etc.
  // are all outside this alphabet.
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  return host;
}

function isWellFormedHostname(host: string): boolean {
  const labels = host.split('.');
  if (labels.length < 2) return false;
  if (!labels.every(l => DNS_LABEL.test(l))) return false;
  // An all-numeric TLD is an IP-ish name, never a registrable domain.
  return !/^\d+$/.test(labels[labels.length - 1]);
}

function storeLabel(host: string, suffix: string): string | null {
  return host.endsWith(suffix) ? host.slice(0, -suffix.length) : null;
}

function classifyLabel(label: string): ParsedStoreHost {
  if (label.includes('.')) return { kind: 'invalid' }; // x.y.ebda.app
  if (isReservedSlug(label)) {
    const app = PLATFORM_LABELS[label];
    return app ? { kind: 'platform', app } : { kind: 'invalid' };
  }
  const format = validateStoreSlugFormat(label);
  return format.ok ? { kind: 'subdomain', slug: format.slug } : { kind: 'invalid' };
}

/**
 * Classify a request host. Pure and total: it never throws and never defaults
 * to a store — anything it cannot positively identify is `invalid` (404).
 */
export function parseStoreHost(
  rawHost: string | null | undefined,
  options: ParseStoreHostOptions = {}
): ParsedStoreHost {
  const host = normalizeHost(rawHost);
  if (!host) return { kind: 'invalid' };

  // Literal IPs and localhost are never stores (except the explicit dev suffixes).
  if (IPV4.test(host)) return { kind: 'invalid' };

  const apex = BRAND.domains.marketing;
  if (host === apex) return { kind: 'platform', app: 'marketing' };

  const brandLabel = storeLabel(host, BRAND.domains.storeSuffix);
  if (brandLabel !== null) {
    // `www.ebda.app` is the marketing site's alias, not a reserved-and-dead label.
    if (brandLabel === 'www') return { kind: 'platform', app: 'marketing' };
    return classifyLabel(brandLabel);
  }

  if (host === 'localhost' || host.endsWith('.localhost')) {
    if (!options.allowDevSuffixes) return { kind: 'invalid' };
    for (const suffix of DEV_STORE_SUFFIXES) {
      const label = storeLabel(host, suffix);
      if (label !== null) {
        const parsed = classifyLabel(label);
        // Reserved platform labels have no dev surface; treat as invalid, not platform.
        return parsed.kind === 'subdomain' ? parsed : { kind: 'invalid' };
      }
    }
    return { kind: 'invalid' };
  }

  if (PREVIEW_HOST_SUFFIXES.some(suffix => host.endsWith(`.${suffix}`))) {
    return { kind: 'platform', app: 'preview' };
  }

  if (!isWellFormedHostname(host)) return { kind: 'invalid' };
  return { kind: 'custom', hostname: host };
}
