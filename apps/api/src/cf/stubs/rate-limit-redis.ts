// `rate-limit-redis` on Workers: limiters use the Durable Object store
// (cf/rate-limit-store.ts), selected in middleware/security.ts.
import { unavailable } from './_unavailable';

export class RedisStore {
  constructor() {
    unavailable('rate-limit-redis', 'limiters use cf/rate-limit-store.ts');
  }
}
