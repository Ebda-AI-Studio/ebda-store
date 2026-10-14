import { Store } from '@ebda/database';

declare module 'express-serve-static-core' {
  interface Request {
    store?: Pick<Store, 'id' | 'ownerId' | 'name' | 'status'>;
  }
}
