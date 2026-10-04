import { unavailable } from './_unavailable';

export function createAdapter(): never {
  return unavailable('@socket.io/redis-adapter', 'a Durable Object is the single coordinator');
}
