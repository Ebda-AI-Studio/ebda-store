/**
 * Tells the MERCHANT that wholesale applications are waiting (review I5): a new application ('received') or applications
 * pending over 48 hours ('nudge'). Three existing paths: the admin socket room (`notification`), the admin OneSignal push, and
 * an email to the store owner. Fail-soft by design: an application is not money, so a failed channel is logged and the
 * application stays (each channel is independent, none can fail the caller).
 */
import { config } from '../config';
import logger from './logger';
import { socketService } from '../services/socket.service';
import { OneSignalService } from '../services/onesignal.service';
import { EmailService } from '../services/email.service';

export const WHOLESALE_APPLICATION_RECEIVED = 'wholesale.application.received';

export async function notifyMerchantOfApplications(
  storeId: string,
  kind: 'received' | 'nudge',
  info: { pendingCount: number; businessName?: string }
): Promise<void> {
  const adminUrl = `${config.adminUrl}/stores/${storeId}/wholesale-applications`;
  const channels: Array<[string, () => unknown]> = [
    [
      'socket',
      () =>
        socketService.notifyStore(storeId, {
          type: WHOLESALE_APPLICATION_RECEIVED,
          title:
            kind === 'received' ? 'New wholesale application' : 'Wholesale applications waiting',
          message:
            kind === 'received'
              ? `${info.businessName ?? 'A buyer'} applied. ${info.pendingCount} waiting.`
              : `${info.pendingCount} waiting over 48 hours.`,
          data: { kind, pendingCount: info.pendingCount, url: adminUrl },
          createdAt: new Date(),
        }),
    ],
    [
      'push',
      () =>
        OneSignalService.notifyAdminsOfWholesaleApplication({
          storeId,
          kind,
          pendingCount: info.pendingCount,
          businessName: info.businessName,
        }),
    ],
    [
      'email',
      () =>
        EmailService.sendWholesaleMerchantNotice(storeId, {
          kind,
          businessName: info.businessName,
          pendingCount: info.pendingCount,
          adminUrl,
        }),
    ],
  ];
  await Promise.all(
    channels.map(async ([name, run]) => {
      try {
        await run();
      } catch (err) {
        logger.warn(
          { err, storeId, channel: name, kind },
          '[wholesale] merchant notification channel failed'
        );
      }
    })
  );
}
