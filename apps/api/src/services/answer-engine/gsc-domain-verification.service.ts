/**
 * Automatic Google Search Console property for a merchant's CUSTOM domain
 * (GAP 2, docs/plans/2026-11-15-gsc-custom-domain-verification.md).
 *
 * Stores on `<slug>.ebda.app` are covered by the platform's `sc-domain:ebda.app`
 * property. A verified custom domain (`ameliaaurum.com`) is a different site, so
 * the platform service account must OWN a property for it. We control the
 * storefront HTML, so the META method needs nothing from the merchant:
 *
 *   1. `webResource.getToken` (type SITE, `https://<host>/`, method META) -> the
 *      token Google derives for (site, service account, method). Deterministic:
 *      the same call always returns the same token, so this is idempotent.
 *   2. Publish it as `Store.googleSiteVerification` — the storefront already
 *      renders that column as `<meta name="google-site-verification">` on the
 *      custom host (apps/web storefront-metadata.ts), and `updateSeo` busts the
 *      storefront cache. A DIFFERENT token already there (the merchant verified
 *      in their own Search Console) is never overwritten: skip, the merchant can
 *      add the service account as a user instead (runbook).
 *   3. `webResource.insert` (META) -> Google fetches the homepage, finds the tag,
 *      and the service account becomes a verified owner.
 *   4. `sites.add` (PUT) registers the property in Search Console.
 *
 * Every step is idempotent and the whole function is FAIL-SOFT: it returns a
 * status, never throws for a Google-side failure (the cron retries tomorrow).
 * Google WRITE calls only ever happen from this module; tests inject a mock.
 */
import logger from '../../lib/logger';
import { fetchWithTimeout } from '../../lib/fetch-timeout';
import {
  listAccessibleGscSites,
  mintGscWriteToken,
  pickGscTarget,
  resetGscSitesCache,
} from './gsc-client';

const SITE_VERIFICATION_BASE = 'https://www.googleapis.com/siteVerification/v1';
const SITES_API_BASE = 'https://www.googleapis.com/webmasters/v3/sites';
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

type GscDomainVerifyStatus =
  | 'no_domain'
  | 'already_connected'
  | 'merchant_token'
  | 'token_failed'
  | 'verify_failed'
  | 'sites_add_failed'
  | 'verified';

/** The Google + store side effects, injectable so tests never reach Google or a DB. */
export interface GscVerificationDeps {
  listSites: () => Promise<string[]>;
  getToken: (siteUrl: string) => Promise<string | null>;
  verify: (siteUrl: string) => Promise<boolean>;
  addSite: (siteUrl: string) => Promise<boolean>;
  readStore: (storeId: string) => Promise<{
    domain: string | null;
    googleSiteVerification: string | null;
  } | null>;
  publishToken: (storeId: string, token: string) => Promise<void>;
}

/** Pulls the `content` value out of the `<meta ... content="X" />` snippet Google returns. */
// pq-allow(unused-export): exported for the unit test of the meta-snippet parser
export function extractMetaToken(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = /content\s*=\s*["']([^"']+)["']/i.exec(raw);
  const token = m ? m[1] : raw.trim();
  return TOKEN_RE.test(token) ? token : null;
}

async function googleFetch(
  url: string,
  accessToken: string,
  init: { method: string; body?: unknown }
): Promise<Response | null> {
  try {
    return await fetchWithTimeout(url, {
      method: init.method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch (err) {
    logger.error({ err }, 'gsc-verify: Google request failed (network error)');
    return null;
  }
}

const site = (siteUrl: string) => ({ type: 'SITE', identifier: siteUrl });

export const realGscVerificationDeps: Pick<
  GscVerificationDeps,
  'listSites' | 'getToken' | 'verify' | 'addSite'
> = {
  listSites: () => listAccessibleGscSites(),
  async getToken(siteUrl) {
    const res = await googleFetch(`${SITE_VERIFICATION_BASE}/token`, await mintGscWriteToken(), {
      method: 'POST',
      body: { site: site(siteUrl), verificationMethod: 'META' },
    });
    if (!res?.ok) {
      logger.warn({ status: res?.status ?? 0 }, 'gsc-verify: getToken rejected');
      return null;
    }
    const data: unknown = await res.json().catch(() => null);
    return extractMetaToken((data as { token?: unknown } | null)?.token);
  },
  async verify(siteUrl) {
    const res = await googleFetch(
      `${SITE_VERIFICATION_BASE}/webResource?verificationMethod=META`,
      await mintGscWriteToken(),
      { method: 'POST', body: { site: site(siteUrl) } }
    );
    if (!res?.ok) logger.info({ status: res?.status ?? 0 }, 'gsc-verify: verify not accepted yet');
    return !!res?.ok;
  },
  async addSite(siteUrl) {
    const res = await googleFetch(
      `${SITES_API_BASE}/${encodeURIComponent(siteUrl)}`,
      await mintGscWriteToken(),
      { method: 'PUT' }
    );
    if (!res?.ok) logger.warn({ status: res?.status ?? 0 }, 'gsc-verify: sites.add rejected');
    return !!res?.ok;
  },
};

export async function ensureGscDomainProperty(
  storeId: string,
  deps: GscVerificationDeps
): Promise<GscDomainVerifyStatus> {
  const store = await deps.readStore(storeId);
  const host = store?.domain
    ?.trim()
    .toLowerCase()
    .replace(/^www\./, '');
  if (!store || !host) return 'no_domain';

  // An exact property (domain or URL-prefix) is already accessible: nothing to do.
  const target = pickGscTarget(host, await deps.listSites());
  if (target && !target.pageHost) return 'already_connected';

  const siteUrl = `https://${host}/`;
  const token = await deps.getToken(siteUrl);
  if (!token) return 'token_failed';

  if (store.googleSiteVerification && store.googleSiteVerification !== token) {
    logger.info({ storeId }, 'gsc-verify: store already has its own verification token, skipping');
    return 'merchant_token';
  }
  if (!store.googleSiteVerification) await deps.publishToken(storeId, token);

  if (!(await deps.verify(siteUrl))) return 'verify_failed';
  const added = await deps.addSite(siteUrl);
  resetGscSitesCache(); // the same cron run's ingest must see the new property
  return added ? 'verified' : 'sites_add_failed';
}
