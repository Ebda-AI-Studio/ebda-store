/**
 * Ebda WhatsApp Business Platform Bridge Service
 *
 * Sends WhatsApp order-lifecycle notifications through a merchant's WBS client
 * by calling the external API endpoint on the WBS backend.
 *
 * Architecture:
 *  - Ebda (this service) calls WBS POST /api/v1/external/send-template
 *  - Auth: x-wbs-api-key header (per-store API key, AES-GCM encrypted at rest)
 *  - Variables are positional strings mapped from the order payload
 *
 * Error contract:
 *  - WbsUnauthorizedError   — 401 from WBS (bad/revoked API key)
 *  - WbsTemplateMissingError — 422 from WBS (template not approved / bad params)
 *  - WbsServerError         — 5xx from WBS (transient; Inngest will retry)
 *  - Error                  — network failure (treated same as 5xx by callers)
 */

import { config } from '../config';
import { encryption } from './encryption.service';
import logger from '../lib/logger';

// ─── Typed error classes ────────────────────────────────────────────────────

export class WbsUnauthorizedError extends Error {
  readonly code = 'WBS_UNAUTHORIZED';
  constructor(message = 'WBS API key rejected (401)') {
    super(message);
    this.name = 'WbsUnauthorizedError';
  }
}

export class WbsTemplateMissingError extends Error {
  readonly code = 'WBS_TEMPLATE_MISSING';
  constructor(message = 'WBS template not approved or bad variables (422)') {
    super(message);
    this.name = 'WbsTemplateMissingError';
  }
}

export class WbsServerError extends Error {
  readonly code = 'WBS_SERVER_ERROR';
  constructor(message = 'WBS backend error (5xx)') {
    super(message);
    this.name = 'WbsServerError';
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WbsSendParams {
  /** Decrypted API key — decryption happens inside sendOrderNotification */
  encryptedApiKey: string;
  recipientPhone: string;
  templateName: string;
  languageCode: string;
  /** Positional string variables matching the template's {{n}} placeholders */
  variables: string[];
  idempotencyKey: string;
  /**
   * Phase 6 final-loop. Optional: when this template send corresponds to a
   * Ebda order, pass the order id so WBS can stamp wa_carts.fwb_order_id
   * during the auto-completion side-effect. Closes the analytics join.
   */
  fwbOrderId?: string;
}

export interface WbsSendResult {
  messageId: string;
  status: 'sent' | 'already_sent';
}

export interface WbsTemplateInfo {
  name: string;
  language: string;
  status: string;
  category: string;
  variableCount: number;
}

export interface WbsMetadataResponse {
  clientId: string;
  businessName: string;
  phoneNumber: string | null;
  wabaId: string | null;
  templates: WbsTemplateInfo[];
}

/**
 * Shape of one abandoned WhatsApp DM cart returned by
 * GET /api/v1/external/abandoned-carts.
 */
export interface AbandonedWaCartItem {
  productName: string;
  quantity: number;
  price?: number;
  currency?: string;
}

export interface AbandonedWaCart {
  waCartId: string;
  fwbStoreId: string | null;
  customerPhone: string; // E.164 (e.g. +201012345678)
  customerName: string | null;
  items: AbandonedWaCartItem[];
  totalFils: number;
  currency: string;
  language: 'en' | 'ar';
  abandonedAt: string; // ISO 8601
  state: string;
}

export interface FetchAbandonedWaCartsOpts {
  /** Minutes of inactivity that qualify as abandoned (default 30, max 1440). */
  minutes?: number;
  /** ISO cursor — only carts created after this timestamp (default 24h ago). */
  since?: string;
}

// ─── Service ────────────────────────────────────────────────────────────────

export class WbsBridgeService {
  private get baseUrl(): string {
    return config.wbsBaseUrl;
  }

  /**
   * Send a WhatsApp template message via the WBS external API.
   *
   * Throws typed errors so the Inngest caller can decide whether to retry:
   *   WbsUnauthorizedError  → do NOT retry, alert Sentry
   *   WbsTemplateMissingError → do NOT retry, alert Sentry
   *   WbsServerError / Error  → rethrow (Inngest retries)
   */
  async sendOrderNotification(params: WbsSendParams): Promise<WbsSendResult> {
    const {
      encryptedApiKey,
      recipientPhone,
      templateName,
      languageCode,
      variables,
      idempotencyKey,
      fwbOrderId,
    } = params;

    // Decrypt the API key before sending
    let apiKey: string;
    try {
      apiKey = encryption.decrypt(encryptedApiKey);
    } catch {
      throw new WbsUnauthorizedError('Failed to decrypt WBS API key');
    }

    const url = `${this.baseUrl}/api/v1/external/send-template`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-wbs-api-key': apiKey,
        },
        body: JSON.stringify({
          recipientPhone,
          templateName,
          languageCode,
          variables,
          idempotencyKey,
          ...(fwbOrderId ? { fwbOrderId } : {}),
        }),
        // 15s timeout — generous for a synchronous template send
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      // Network error or timeout — let Inngest retry
      logger.error({ err: (err as Error).message, url }, '[WBS-BRIDGE] Network error calling WBS');
      throw new WbsServerError(`WBS unreachable: ${(err as Error).message}`);
    }

    // Parse body regardless of status for error detail
    let body: Record<string, unknown> = {};
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      // Ignore JSON parse failure — response body may be empty on 5xx
    }

    if (response.status === 401) {
      logger.error(
        { statusCode: response.status },
        '[WBS-BRIDGE] WBS rejected API key — disabling store integration'
      );
      throw new WbsUnauthorizedError((body.message as string) || 'WBS returned 401');
    }

    if (response.status === 422 || response.status === 400) {
      logger.error(
        { statusCode: response.status, body },
        '[WBS-BRIDGE] WBS rejected template/params'
      );
      throw new WbsTemplateMissingError(
        (body.message as string) || `WBS returned ${response.status}`
      );
    }

    if (response.status >= 500) {
      logger.error({ statusCode: response.status }, '[WBS-BRIDGE] WBS server error — will retry');
      throw new WbsServerError(`WBS returned ${response.status}`);
    }

    if (!response.ok) {
      throw new WbsServerError(`WBS returned unexpected status ${response.status}`);
    }

    const messageId = (body.messageId as string) || '';
    const status = (body.status as 'sent' | 'already_sent') || 'sent';

    logger.info({ messageId, status, templateName }, '[WBS-BRIDGE] Template sent');

    return { messageId, status };
  }

  /**
   * Fetch client metadata from WBS using the provided (plaintext) API key.
   *
   * Used during the "connect by key" UX: Ebda calls this to verify the key and
   * auto-populate `wbsClientId`, `businessName`, and available templates.
   *
   * The caller is responsible for decrypting the key before passing it here.
   *
   * Throws:
   *   WbsUnauthorizedError   — 401 (bad/revoked key)
   *   WbsServerError         — 5xx or network failure
   */
  async fetchMetadata(plaintextApiKey: string): Promise<WbsMetadataResponse> {
    const url = `${this.baseUrl}/api/v1/external/metadata`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          'x-wbs-api-key': plaintextApiKey,
        },
        // 10s timeout — this is a synchronous UX-blocking call
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      logger.error(
        { err: (err as Error).message, url },
        '[WBS-BRIDGE] Network error fetching metadata'
      );
      throw new WbsServerError(`WBS metadata unreachable: ${(err as Error).message}`);
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      // Ignore parse failure on non-JSON 5xx
    }

    if (response.status === 401 || response.status === 403) {
      throw new WbsUnauthorizedError((body.message as string) || `WBS returned ${response.status}`);
    }

    if (response.status >= 500) {
      throw new WbsServerError(`WBS metadata endpoint returned ${response.status}`);
    }

    if (!response.ok) {
      throw new WbsServerError(`WBS metadata returned unexpected status ${response.status}`);
    }

    logger.info(
      { clientId: body.clientId, businessName: body.businessName },
      '[WBS-BRIDGE] Metadata fetched'
    );

    return {
      clientId: (body.clientId as string) || '',
      businessName: (body.businessName as string) || '',
      phoneNumber: (body.phoneNumber as string | null) || null,
      wabaId: (body.wabaId as string | null) || null,
      templates: (body.templates as WbsTemplateInfo[]) || [],
    };
  }

  /**
   * Fetch abandoned WhatsApp DM carts from WBS for a given store's API key.
   *
   * Used by Ebda's abandoned-cart sweep to merge WBS DM carts with website carts.
   * wa_carts remains the single source of truth in WBS — no duplication.
   *
   * Degraded-mode contract: returns [] on any error (401, 5xx, network) so the
   * sweep keeps running for website carts even when WBS is unreachable.
   *
   * @param plaintextApiKey  — Decrypted WBS API key (decrypt before calling).
   * @param opts             — minutes and since cursor (both optional).
   */
  async fetchAbandonedWaCarts(
    plaintextApiKey: string,
    opts: FetchAbandonedWaCartsOpts = {}
  ): Promise<AbandonedWaCart[]> {
    const params = new URLSearchParams();
    if (opts.minutes !== undefined) params.set('minutes', String(opts.minutes));
    if (opts.since !== undefined) params.set('since', opts.since);

    const url = `${this.baseUrl}/api/v1/external/abandoned-carts${params.size > 0 ? `?${params}` : ''}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { 'x-wbs-api-key': plaintextApiKey },
        // 15s timeout — generous for a background sweep call
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      logger.error(
        { err: (err as Error).message, url },
        '[WBS-BRIDGE] Network error fetching abandoned WA carts — returning empty (degraded mode)'
      );
      return [];
    }

    if (response.status === 401) {
      logger.warn('[WBS-BRIDGE] WBS rejected API key on abandoned-carts fetch — returning empty');
      throw new WbsUnauthorizedError('WBS returned 401 on abandoned-carts');
    }

    if (response.status >= 500) {
      logger.warn(
        { statusCode: response.status },
        '[WBS-BRIDGE] WBS server error on abandoned-carts — returning empty (degraded mode)'
      );
      return [];
    }

    if (!response.ok) {
      logger.warn(
        { statusCode: response.status },
        '[WBS-BRIDGE] Unexpected status on abandoned-carts — returning empty'
      );
      return [];
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      logger.warn('[WBS-BRIDGE] Failed to parse abandoned-carts JSON — returning empty');
      return [];
    }

    const carts = (body.carts as AbandonedWaCart[] | undefined) ?? [];
    logger.info({ count: carts.length }, '[WBS-BRIDGE] Abandoned WA carts fetched');

    return carts;
  }

  /**
   * Sync the per-store WA customer-DM ordering flag to WBS.
   *
   * Called when a merchant toggles "Customer ordering via WhatsApp DM" in the
   * Ebda Connection tab. WBS uses `wa_ordering_enabled` on the client row to
   * decide whether to activate the ordering state machine for inbound DMs.
   *
   * Throws:
   *   WbsUnauthorizedError — 401 (bad/revoked key)
   *   WbsServerError       — 5xx or network failure
   */
  async syncWaOrdering(
    plaintextApiKey: string,
    enabled: boolean
  ): Promise<{ wa_ordering_enabled: boolean }> {
    const url = `${this.baseUrl}/api/v1/external/wa-ordering`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-wbs-api-key': plaintextApiKey,
        },
        body: JSON.stringify({ enabled }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      logger.error(
        { err: (err as Error).message, url },
        '[WBS-BRIDGE] Network error syncing wa-ordering'
      );
      throw new WbsServerError(`WBS wa-ordering unreachable: ${(err as Error).message}`);
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      // Ignore parse failure
    }

    if (response.status === 401 || response.status === 403) {
      throw new WbsUnauthorizedError((body.message as string) || `WBS returned ${response.status}`);
    }

    if (response.status >= 500) {
      throw new WbsServerError(`WBS wa-ordering returned ${response.status}`);
    }

    if (!response.ok) {
      throw new WbsServerError(`WBS wa-ordering returned unexpected status ${response.status}`);
    }

    logger.info({ enabled }, '[WBS-BRIDGE] wa_ordering_enabled synced to WBS');

    return { wa_ordering_enabled: (body.wa_ordering_enabled as boolean) ?? enabled };
  }
}

export const wbsBridgeService = new WbsBridgeService();
