import type { StoreDO } from '../src/store-do';

declare global {
  namespace Cloudflare {
    interface Env {
      STORE_DO: DurableObjectNamespace<StoreDO>;
      STORE_DO_ENABLED_IDS: string;
      SEED_TOKEN?: string;
      SPIKE_BACKUPS?: R2Bucket;
    }
  }
}
export {};
