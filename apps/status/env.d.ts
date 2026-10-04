import type { StatusStore } from './src/store';

declare global {
  namespace Cloudflare {
    interface Env {
      STATUS_STORE: DurableObjectNamespace<StatusStore>;
      /** Shared secret for the authenticated incident endpoints (a Worker secret). */
      STATUS_SECRET?: string;
      FAIL_THRESHOLD?: string;
      RECOVER_THRESHOLD?: string;
    }
  }
}
export {};
