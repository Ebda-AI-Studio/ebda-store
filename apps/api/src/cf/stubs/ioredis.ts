// `ioredis` on Workers. redis.service.ts picks the Durable Object / KV client
// (cf/ioredis-cf.ts) by runtime; this alias only keeps ioredis (node:net, ~200 KB)
// out of the bundle.
import { unavailable } from './_unavailable';

export default class Redis {
  constructor() {
    unavailable('ioredis', 'redis.service uses cf/ioredis-cf.ts (AuthState Durable Object + KV)');
  }
}
export { Redis };
