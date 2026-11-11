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
      EBDA_OS_BRAIN_URL?: string;
      EBDA_OS_INGEST_TOKEN?: string;
      FAIL_THRESHOLD?: string;
      RECOVER_THRESHOLD?: string;
      /** `on` shows the Services dropdown in the shared header (SERVICES-IA-1); passed by the deploy workflow with --var. */
      EBDA_SERVICE_LINES?: string;
    }
  }
}
export {};
