import type { InngestFunction } from 'inngest';
import { prisma } from '@force/database';
import { InvoiceService } from '../../../services/invoice.service';
import { EmailService } from '../../../services/email.service';
import logger from '../../logger';
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

    const html = await step.run('render-invoice', () =>
      InvoiceService.generateInvoice(storeId, orderId)
    );

    const order = await step.run('load-order-number', async () => {
      const row = await prisma.order.findUnique({
        where: { id: orderId },
        select: { orderNumber: true },
      });
      if (!row) throw new Error(`Order ${orderId} not found`);
      return row;
    });

    await step.run('send-email', async () => {
      try {
        await EmailService.send({
          to,
          subject: `Invoice ${order.orderNumber}`,
          html,
        });
      } catch (err) {
        logger.error({ err, orderId, to }, 'Invoice email send failed');
        throw err;
      }
    });
  }
);
