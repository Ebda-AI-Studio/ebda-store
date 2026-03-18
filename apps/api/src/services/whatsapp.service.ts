/**
 * WhatsApp Service
 * Meta WhatsApp Cloud API client using raw fetch
 */

import logger from '../lib/logger';

const META_API_BASE = 'https://graph.facebook.com/v21.0';

export interface WhatsAppConfig {
  phoneNumberId: string;
  accessToken: string;
}

export interface WhatsAppMessageResult {
  messageId: string;
}

export interface WebhookStatusUpdate {
  messageId: string;
  status: string;
  timestamp: string;
}

class WhatsAppService {
  /**
   * Send a template message via Meta WhatsApp Cloud API
   */
  async sendTemplateMessage(
    config: WhatsAppConfig,
    to: string,
    templateName: string,
    languageCode: string,
    variables: string[]
  ): Promise<WhatsAppMessageResult> {
    const url = `${META_API_BASE}/${config.phoneNumberId}/messages`;

    const body: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        components:
          variables.length > 0
            ? [
                {
                  type: 'body',
                  parameters: variables.map(v => ({ type: 'text', text: v })),
                },
              ]
            : [],
      },
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      const errorInfo = (data.error as Record<string, unknown>) || {};
      const message = (errorInfo.message as string) || `Meta API error: ${response.status}`;
      logger.error(
        { status: response.status, error: errorInfo, to, templateName },
        '[WHATSAPP] sendTemplateMessage failed'
      );
      throw new Error(message);
    }

    const messages = data.messages as Array<Record<string, unknown>>;
    const messageId = (messages?.[0]?.id as string) || '';

    logger.info({ messageId, to, templateName }, '[WHATSAPP] Template message sent');

    return { messageId };
  }

  /**
   * Verify a Meta webhook challenge
   */
  verifyWebhook(
    mode: string,
    token: string,
    challenge: string,
    verifyToken: string
  ): string | null {
    if (mode === 'subscribe' && token === verifyToken) {
      logger.info('[WHATSAPP] Webhook verified');
      return challenge;
    }
    logger.warn({ mode, token }, '[WHATSAPP] Webhook verification failed');
    return null;
  }

  /**
   * Process a Meta webhook event payload and extract message status updates
   */
  processWebhookEvent(body: Record<string, unknown>): WebhookStatusUpdate[] {
    const results: WebhookStatusUpdate[] = [];

    try {
      const entry = body.entry as Array<Record<string, unknown>>;
      if (!Array.isArray(entry)) return results;

      for (const entryItem of entry) {
        const changes = entryItem.changes as Array<Record<string, unknown>>;
        if (!Array.isArray(changes)) continue;

        for (const change of changes) {
          const value = change.value as Record<string, unknown>;
          if (!value) continue;

          const statuses = value.statuses as Array<Record<string, unknown>>;
          if (!Array.isArray(statuses)) continue;

          for (const statusEntry of statuses) {
            const messageId = statusEntry.id as string;
            const status = statusEntry.status as string;
            const timestamp = statusEntry.timestamp as string;

            if (messageId && status && ['sent', 'delivered', 'read', 'failed'].includes(status)) {
              results.push({ messageId, status, timestamp });
            }
          }
        }
      }
    } catch (error) {
      logger.error({ err: error }, '[WHATSAPP] Error processing webhook event');
    }

    return results;
  }
}

// Singleton instance
export const whatsappService = new WhatsAppService();
