// `socket.io` on Workers: realtime is the StoreRealtime Durable Object
// (cf/store-realtime.ts); socket.service.ts never constructs a Server there.
import { unavailable } from './_unavailable';

export class Server {
  constructor() {
    unavailable('socket.io', 'realtime is the StoreRealtime Durable Object');
  }
}
export type Socket = unknown;
