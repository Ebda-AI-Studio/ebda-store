import logger from './logger';
import { socketService } from '../services/socket.service';
export type { UiRefreshEvent } from '../services/socket.service';

/**
 * Broadcast a UI refresh signal to all admin clients connected to this store's
 * Socket.io room. Admin pages subscribe via NotificationContext and trigger
 * refetches when a signal matching their page lands.
 *
 * Uses the existing `store:${storeId}` room that `subscribe:store` joins.
 * No-op if socket.io isn't initialized (e.g. during tests). Never throws —
 * UI freshness is best-effort, not load-bearing.
 */
export function broadcastToStore(
  storeId: string,
  event: import('../services/socket.service').UiRefreshEvent
): void {
  try {
    socketService.broadcastUiRefresh(storeId, event);
  } catch (err) {
    logger.warn({ err, storeId, event: event.name }, 'broadcastToStore failed (non-fatal)');
  }
}
