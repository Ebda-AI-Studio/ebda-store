/**
 * Meta Commerce auto-provisioner.
 *
 * Ebda holds ONE master access token at FORCE_AI_META_ADMIN_TOKEN with the
 * `business_management` + `catalog_management` scopes on the Ebda parent
 * Business Manager (FORCE_AI_META_BM_ID). This service uses those credentials
 * to create a per-merchant Commerce Catalog + assign the long-lived system
 * user, then hand the catalog id + a derived system-user token back to FWB so
 * the merchant doesn't have to navigate Meta Business Manager themselves.
 *
 * One-time Ebda setup (NOT something Ahmad does per merchant):
 *   1. Create Ebda parent Business Manager at https://business.facebook.com/
 *   2. Create a System User named `force-ai-catalog-provisioner` with admin role
 *   3. Generate a never-expires token with scopes:
 *        - business_management
 *        - catalog_management
 *        - whatsapp_business_management
 *   4. Set FORCE_AI_META_BM_ID + FORCE_AI_META_ADMIN_TOKEN on Railway
 *   5. Set META_GRAPH_API_VERSION (default v21.0) if you want to pin
 *
 * After that, every merchant onboard just clicks "Provision automatically" in
 * the FWB admin and the catalog/business/token are filled in for them.
 */

import logger from '../lib/logger';

const GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

export interface ProvisionResult {
  catalogId: string;
  businessId: string;
  accessToken: string;
}

export class MetaProvisionerError extends Error {
  constructor(
    message: string,
    public readonly stage: string,
    public readonly metaError?: unknown
  ) {
    super(message);
    this.name = 'MetaProvisionerError';
  }
}

function getCredentials(): { bmId: string; adminToken: string } {
  const bmId = process.env.FORCE_AI_META_BM_ID;
  const adminToken = process.env.FORCE_AI_META_ADMIN_TOKEN;

  if (!bmId || !adminToken) {
    throw new MetaProvisionerError(
      'Meta auto-provisioning is not configured. Set FORCE_AI_META_BM_ID + ' +
        'FORCE_AI_META_ADMIN_TOKEN on Railway (one-time Ebda setup).',
      'config'
    );
  }
  return { bmId, adminToken };
}

export function isProvisioningConfigured(): boolean {
  return Boolean(process.env.FORCE_AI_META_BM_ID && process.env.FORCE_AI_META_ADMIN_TOKEN);
}

async function graph<T>(url: string, init: RequestInit, stage: string): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    logger.error({ url, status: res.status, body, stage }, 'meta-provisioner: graph error');
    const errMsg =
      (body as { error?: { message?: string } })?.error?.message ||
      `Meta Graph API responded ${res.status}`;
    throw new MetaProvisionerError(errMsg, stage, body);
  }
  return body as T;
}

/**
 * Create a new Commerce Catalog under the Ebda parent Business Manager.
 * Returns the new catalog id.
 */
async function createCatalog(name: string): Promise<string> {
  const { bmId, adminToken } = getCredentials();
  const data = await graph<{ id: string }>(
    `${GRAPH_BASE}/${bmId}/owned_product_catalogs`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        name,
        vertical: 'commerce',
        access_token: adminToken,
      }),
    },
    'create_catalog'
  );
  if (!data.id) {
    throw new MetaProvisionerError(
      'Meta returned no catalog id from create_catalog',
      'create_catalog',
      data
    );
  }
  return data.id;
}

/**
 * Grant the Ebda provisioner system user MANAGE permission on the new
 * catalog. Without this the same admin token can't subsequently call /products
 * on the catalog to publish merchandise.
 */
async function assignCatalogToProvisioner(catalogId: string): Promise<void> {
  const { adminToken } = getCredentials();
  const provisionerUserId = process.env.FORCE_AI_META_PROVISIONER_USER_ID;
  if (!provisionerUserId) {
    // Optional: if the admin token IS the provisioner token there's nothing to
    // assign. Skip silently — the admin token already has access.
    return;
  }
  await graph<unknown>(
    `${GRAPH_BASE}/${catalogId}/assigned_users`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        user: provisionerUserId,
        tasks: 'MANAGE',
        access_token: adminToken,
      }),
    },
    'assign_catalog'
  );
}

/**
 * Provision a new Meta Commerce catalog for a merchant.
 *
 * Returns the catalog id + the parent BM id + the token to persist on Store.
 * For the MVP we hand back the SAME admin token (catalog-scoped via the
 * assignment above). When we later want per-merchant token isolation we can
 * switch to creating a system user per merchant.
 */
export async function provisionCatalog(opts: {
  storeId: string;
  catalogName: string;
}): Promise<ProvisionResult> {
  const { bmId, adminToken } = getCredentials();
  logger.info(
    { storeId: opts.storeId, catalogName: opts.catalogName },
    'meta-provisioner: starting provision'
  );

  const catalogId = await createCatalog(opts.catalogName);
  await assignCatalogToProvisioner(catalogId);

  logger.info(
    { storeId: opts.storeId, catalogId, businessId: bmId },
    'meta-provisioner: provisioned successfully'
  );

  return {
    catalogId,
    businessId: bmId,
    accessToken: adminToken,
  };
}
