import type { InngestFunction } from 'inngest';
import { EmailService } from '../../../services/email.service';
import { storeContactTarget } from '../../../services/store-contact.service';
import logger from '../../logger';
import { maskEmail, scrubEmails } from '../../pii-mask';
import { inngest } from '../client';

type ContactMessage = { name: string; email: string; subject: string; message: string };
export interface ContactStep {
  run: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
}

/**
 * Sends a storefront contact-page message to the STORE it was written on (Ruling FU46-1):
 * the store's public contact email, else the owner's account email. With no usable store-owned
 * address nothing is mailed (Ruling FU46-1c): a shopper's name, email and message never go to
 * Ebda's own inbox. Before FU46-1 every store's messages went to `config.smtpFromEmail` — Ebda's
 * own sender — and no merchant ever saw one.
 *
 * #645 still holds: queued on Inngest (3 retries, dead-letter via alerts-failure-watch); a
 * send failure is rethrown so it retries. A store that is gone or turned into a demo store
 * between submit and send gets nothing — there is no one to deliver to, so no retry either.
 */
export async function handleContactFormSubmitted({
  event,
  step,
}: {
  event: { name: string; data: unknown };
  step: ContactStep;
}): Promise<void> {
  const { storeId, name, email, subject, message } = (event.data ?? {}) as Partial<
    ContactMessage & { storeId: string }
  >;
  if (!name || !email || !subject || !message) {
    logger.warn({ event: event.name }, 'contact/form.submitted fired without required fields');
    return;
  }
  const data: ContactMessage = { name, email, subject, message };

  if (!storeId) {
    // Enqueued before FU46-1 deployed: its only destination was Ebda's inbox. Dropped (FU46-1c).
    logger.warn({ event: event.name }, '[CONTACT] queued without a store; message dropped');
    return;
  }

  await step.run('send-email', async () => {
    const target = await storeContactTarget(storeId);
    if (!target || target.isDemo) {
      logger.warn({ storeId }, '[CONTACT] store gone or demo; message dropped');
      return;
    }
    if (!target.to) {
      // No store-owned address (FU46-1c). No admin inbox model exists to hold it, so it is
      // dropped, success is returned to the shopper upstream, and the log carries no PII.
      logger.warn({ storeId }, '[CONTACT] store has no usable address; message not delivered');
      return;
    }
    try {
      await EmailService.sendStoreContactMessage(storeId, target.to, data);
    } catch (err) {
      // D8: provider errors can echo the recipient/shopper address; never log the raw error.
      const reason = scrubEmails(err instanceof Error ? err.message : String(err), [
        email,
        target.to,
      ]);
      logger.error({ storeId, email: maskEmail(email), reason }, '[CONTACT] message email failed');
      throw err; // Inngest retries; alerts-failure-watch pages after the final one.
    }
  });
}

export const contactFormSend: InngestFunction.Any = inngest.createFunction(
  {
    id: 'contact-form-send',
    name: 'Send a storefront contact message to its store',
    retries: 3,
    triggers: [{ event: 'contact/form.submitted' }],
  },
  async ({ event, step }) =>
    handleContactFormSubmitted({ event, step: step as unknown as ContactStep })
);
