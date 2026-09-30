import type { InngestFunction } from 'inngest';
import { prisma, runInTenantContext } from '@force/database';
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
export const invoiceEmail: InngestFunction.Any = inngest.createFunction(
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

    // InvoiceService.generateInvoiceEmail reads the order; it runs its own DB
    // calls that need tenant context. Wrap in runInTenantContext so FORCE
    // RLS lets those reads through (Inngest has no HTTP middleware context).
    const html = await step.run('render-invoice', () =>
      runInTenantContext(storeId, () => InvoiceService.generateInvoiceEmail(storeId, orderId))
    );

    const order = await step.run('load-order-number', () =>
      runInTenantContext(storeId, async () => {
        const row = await prisma.order.findUnique({
          where: { id: orderId },
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
