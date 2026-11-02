/**
 * SMS Service
 * Unifonic REST API client using raw fetch
 */

import logger from '../lib/logger';
import { maskPhone } from '../lib/pii-mask';
import { timedFetch } from '../lib/fetch-with-timeout';

const UNIFONIC_BASE = 'https://el.cloud.unifonic.com/rest';
const UNIFONIC_API = `${UNIFONIC_BASE}/SMS/messages`;
/** Read-only account-info endpoint — safe for connectivity checks (no SMS sent). */
const UNIFONIC_ACCOUNT_INFO_API = `${UNIFONIC_BASE}/Account/info`;

export interface SmsConfig {
  appSid: string;
  senderId: string;
}

interface UnifonicResponse {
  success: boolean;
  message: string;
  errorCode?: string;
  data?: {
    messageId: string;
    status: string;
  };
}

interface UnifonicAccountInfoResponse {
  success: boolean;
  message: string;
  errorCode?: string;
  data?: {
    AppName?: string;
    AppStatus?: string;
    Balance?: number;
    CurrencyCode?: string;
  };
}

class SmsService {
  /**
   * Verify Unifonic credentials by calling the read-only Account/info endpoint.
   * Does NOT send an SMS. Returns {ok: true} when the AppSid is valid and the
   * account is active; {ok: false, reason} for any failure.
   *
   * Security: the sanitized `reason` string contains no credential values.
   */
  async verifyCredentials(config: SmsConfig): Promise<{ ok: boolean; reason?: string }> {
    if (!config.appSid || !config.senderId) {
      return {
        ok: false,
        reason: 'SMS credentials are not configured (appSid / senderId missing)',
      };
    }

    const body = new URLSearchParams({ AppSid: config.appSid });

    let response: Response;
    try {
      response = await timedFetch('sms.account')(UNIFONIC_ACCOUNT_INFO_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        // Hard timeout so the test-connection route never hangs
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === 'TimeoutError';
      logger.warn({ storeCredentialsPresent: true }, '[SMS] verifyCredentials network error');
      return {
        ok: false,
        reason: isTimeout ? 'SMS provider did not respond in time' : 'Could not reach SMS provider',
      };
    }

    if (!response.ok) {
      logger.warn(
        { status: response.status },
        '[SMS] verifyCredentials: provider returned non-2xx'
      );
      return {
        ok: false,
        reason: `SMS provider returned HTTP ${response.status} — credentials may be invalid`,
      };
    }

    let result: UnifonicAccountInfoResponse;
    try {
      result = (await response.json()) as UnifonicAccountInfoResponse;
    } catch {
      return { ok: false, reason: 'SMS provider returned an unreadable response' };
    }

    if (!result.success) {
      // errorCode is a provider-level code (e.g. "ER-04" = invalid AppSid).
      // We surface the errorCode but NOT the appSid value itself.
      const code = result.errorCode ?? 'unknown';
      logger.warn({ errorCode: code }, '[SMS] verifyCredentials: provider reported failure');
      return {
        ok: false,
        reason: `SMS provider rejected the credentials (provider code: ${code})`,
      };
    }

    return { ok: true };
  }

  /**
   * Send an SMS via Unifonic REST API
   */
  async sendSms(
    config: SmsConfig,
    to: string,
    message: string
  ): Promise<{ messageId: string | null }> {
    const body = new URLSearchParams({
      AppSid: config.appSid,
      SenderID: config.senderId,
      Recipient: to,
      Body: message,
    });

    const response = await timedFetch('sms.send')(UNIFONIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      logger.error(
        { status: response.status, body: text, to: maskPhone(to) },
        '[SMS] Unifonic API request failed'
      );
      throw new Error(`Unifonic API error: ${response.status} ${response.statusText}`);
    }

    const result = (await response.json()) as UnifonicResponse;

    if (!result.success) {
      logger.error(
        { errorCode: result.errorCode, message: result.message, to: maskPhone(to) },
        '[SMS] Unifonic API returned failure'
      );
      throw new Error(`Unifonic error ${result.errorCode}: ${result.message}`);
    }

    // `success: true` means Unifonic ACCEPTED the message — it will be
    // delivered and billed. A missing messageId is a reporting gap, not a
    // failed send: throwing here made the queue retry an accepted message up
    // to maxAttempts times (a real text and a real credit each, issue 2389).
    // Report it as sent with an unknown (null) provider id instead.
    const messageId = result.data?.messageId || null;
    if (messageId === null) {
      logger.warn(
        { to: maskPhone(to) },
        '[SMS] Unifonic accepted the SMS but returned no messageId — recorded as sent, id unknown'
      );
    } else {
      logger.info({ messageId, to: maskPhone(to) }, '[SMS] SMS sent successfully');
    }

    return { messageId };
  }
}

// Singleton instance
export const smsService = new SmsService();
