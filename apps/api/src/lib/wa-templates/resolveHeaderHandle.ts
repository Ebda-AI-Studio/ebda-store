/**
 * Resolve the header_handle for a store's templates.
 *
 * Used by the wa-templates generate + sync flow when the store has
 * opted in (Store.wbsTemplateUseLogoHeader=true). Calls the WBS
 * /external/templates/upload-header-handle endpoint with the store's
 * logo URL — WBS does the Meta resumable upload using the merchant's
 * own WhatsApp App credentials and returns the handle.
 *
 * Skip cleanly when:
 *   - opt-in is false
 *   - store has no logo set
 *   - WBS upload fails (we don't want logo issues to block templates;
 *     templates can still be approved without the header image)
 *
 * The handle is per-template-creation. Each template submitted to Meta
 * needs its own header_handle, BUT they can all share the same upload
 * (Meta accepts the same handle on multiple templates in the same batch).
 * So one upload per sync run.
 */

import logger from '../../lib/logger';

export interface ResolveHeaderHandleParams {
  /** Decrypted WBS api key for the X-WBS-API-KEY header. */
  wbsApiKey: string;
  /** Store.logo URL (https). Pass null/undefined to skip. */
  logoUrl: string | null | undefined;
  /** Store.wbsTemplateUseLogoHeader. When false, skips the upload. */
  optedIn: boolean;
  /** WBS base URL (config.wbsBaseUrl). */
  wbsBaseUrl: string;
}

export async function resolveHeaderHandle({
  wbsApiKey,
  logoUrl,
  optedIn,
  wbsBaseUrl,
}: ResolveHeaderHandleParams): Promise<string | null> {
  if (!optedIn) return null;
  if (!logoUrl) {
    logger.info('[resolveHeaderHandle] opted in but no store logo set — skipping');
    return null;
  }
  if (!logoUrl.startsWith('https://')) {
    logger.warn(
      { logoUrl },
      '[resolveHeaderHandle] store logo is not https — Meta upload will reject'
    );
    return null;
  }

  try {
    const response = await fetch(`${wbsBaseUrl}/api/v1/external/templates/upload-header-handle`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-wbs-api-key': wbsApiKey,
      },
      body: JSON.stringify({ imageUrl: logoUrl }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await response.json().catch(() => ({}))) as {
      success?: boolean;
      handle?: string;
      error?: string;
      message?: string;
    };
    if (!response.ok || !body.success || !body.handle) {
      logger.warn(
        { status: response.status, body },
        '[resolveHeaderHandle] WBS upload returned non-success'
      );
      return null;
    }
    logger.info(
      { handlePrefix: body.handle.slice(0, 12) + '...' },
      '[resolveHeaderHandle] uploaded'
    );
    return body.handle;
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[resolveHeaderHandle] upload call failed');
    return null;
  }
}
