import type { InngestFunction } from 'inngest';
import { EmailService } from '../../../services/email.service';
import logger from '../../logger';
import { maskEmail } from '../../pii-mask';
import { inngest } from '../client';

/**
 * Sends the platform "contact us" notification email (POST /public/contact,
 * apps/web's non-tenant contact page — the destination is always
 * `config.smtpFromEmail`, never a per-store inbox).
 *
 * #645: the route used to call `EmailService.sendContactForm(...).catch(...)`
 * fire-and-forget and always respond `success:true` — an SMTP failure lost the
 * submission permanently and silently, with zero durable record. Moving the
 * send onto Inngest gives it the platform's standard retry (3x) + dead-letter
 * alerting (`alerts-failure-watch` fires a P1 the moment retries are
 * exhausted) instead of a swallowed `.catch`. The route itself now fails the
 * request (no `success:true`) when the ENQUEUE fails, so a visitor is never
 * told "sent" for a message nothing will ever act on.
 */
export const contactFormSend: InngestFunction.Any = inngest.createFunction(
  {
    id: 'contact-form-send',
    name: 'Send platform contact-form notification email',
    retries: 3,
    triggers: [{ event: 'contact/form.submitted' }],
  },
  async ({ event, step }) => {
    const { name, email, subject, message } = event.data as {
      name?: string;
      email?: string;
      subject?: string;
      message?: string;
    };

    if (!name || !email || !subject || !message) {
      logger.warn({ event: event.name }, 'contact/form.submitted fired without required fields');
      return;
    }

    await step.run('send-email', async () => {
      try {
        await EmailService.sendContactForm({ name, email, subject, message });
      } catch (err) {
        logger.error({ err, email: maskEmail(email) }, '[CONTACT] notification email failed');
        throw err; // let Inngest retry; alerts-failure-watch pages after the final one.
      }
    });
  }
);
