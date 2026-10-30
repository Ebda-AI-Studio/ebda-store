import type { StatusStore } from './src/store';

declare global {
  namespace Cloudflare {
    interface Env {
      STATUS_STORE: DurableObjectNamespace<StatusStore>;
      /** Shared secret for the authenticated incident endpoints (a Worker secret). */
      STATUS_SECRET?: string;
      /** Telegram alert bridge (Worker secrets): an incident opening/resolving is sent to Ahmad. */
      TELEGRAM_BOT_TOKEN?: string;
      TELEGRAM_ALERT_CHAT_ID?: string;
      FAIL_THRESHOLD?: string;
      RECOVER_THRESHOLD?: string;
    }
  }
}
export {};
