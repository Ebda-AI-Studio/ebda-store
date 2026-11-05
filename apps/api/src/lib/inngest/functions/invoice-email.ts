import type { JobDef } from '../../jobs/types';
import { storeDb } from '../../repo-factory';
import { runInStoreCtx } from '../../jobs/store-db';
import { InvoiceService } from '../../../services/invoice.service';
import { EmailService } from '../../../services/email.service';
import logger from '../../logger';
import { maskEmail } from '../../pii-mask';
import { inngest } from '../client';

/**
 * Renders the order invoice and emails it to the customer. Lives on
 * Inngest so the admin click returns instantly and a slow SMTP host
 * can't block the request — the email goes through the queue's retry
 * machinery instead.
 */
export const invoiceEmail: JobDef = inngest.createFunction(
  {
    id: 'invoice-email',
    name: 'Email order invoice to customer',
    concurrency: { key: 'event.data.storeId', limit: 5 },
    retries: 3,
    triggers: [{ event: 'order/invoice.email-requested' }],
  },
  async ({ event, step }) => {
    const { orderId, storeId, to } = event.data;

    if (!orderId || !storeId || !to) {
      logger.warn({ event: event.name }, 'invoice email-requested fired without ids — skipping');
      return;
    }

    // InvoiceService.generateInvoiceEmail reads the order through the store's backend (its Durable Object, or Postgres).
    // runInStoreCtx opens the tenant scope a Postgres store needs for FORCE RLS (Inngest has no HTTP middleware context).
    const html = await step.run('render-invoice', () =>
      runInStoreCtx(storeId, () => InvoiceService.generateInvoiceEmail(storeId, orderId))
    );

    const order = await step.run('load-order-number', () =>
      runInStoreCtx(storeId, async () => {
        const row = await (
          await storeDb(storeId)
        ).order.findUnique({
          where: { id: orderId, storeId },
          select: { orderNumber: true, locale: true },
        });
        if (!row) throw new Error(`Order ${orderId} not found`);
        return row;
      })
    );

    const orderLocale = (order.locale ?? undefined) as 'en' | 'ar' | undefined;

    await step.run('send-email', async () => {
      try {
        await EmailService.sendInvoice(
          storeId,
          { to, orderNumber: order.orderNumber, html },
          orderLocale
        );
      } catch (err) {
        logger.error({ err, orderId, to: maskEmail(to) }, 'Invoice email send failed');
        throw err;
      }
    });
  }
);
