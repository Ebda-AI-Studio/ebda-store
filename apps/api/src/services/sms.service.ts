/**
 * SMS Service
 * Unifonic REST API client using raw fetch
 */

import logger from '../lib/logger';

const UNIFONIC_API = 'https://el.cloud.unifonic.com/rest/SMS/messages';

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

class SmsService {
  /**
   * Send an SMS via Unifonic REST API
   */
  async sendSms(config: SmsConfig, to: string, message: string): Promise<{ messageId: string }> {
    const body = new URLSearchParams({
      AppSid: config.appSid,
      SenderID: config.senderId,
      Recipient: to,
      Body: message,
    });

    const response = await fetch(UNIFONIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      logger.error(
        { status: response.status, body: text, to },
        '[SMS] Unifonic API request failed'
      );
      throw new Error(`Unifonic API error: ${response.status} ${response.statusText}`);
    }

    const result = (await response.json()) as UnifonicResponse;

    if (!result.success) {
      logger.error(
        { errorCode: result.errorCode, message: result.message, to },
        '[SMS] Unifonic API returned failure'
      );
      throw new Error(`Unifonic error ${result.errorCode}: ${result.message}`);
    }

    if (!result.data?.messageId) {
      throw new Error('Unifonic API did not return a messageId');
    }

    logger.info({ messageId: result.data.messageId, to }, '[SMS] SMS sent successfully');

    return { messageId: result.data.messageId };
  }
}

// Singleton instance
export const smsService = new SmsService();
