import { DurableObject } from 'cloudflare:workers';
import { makeDrizzle, listProducts, addCartItem, createOrder } from '../src/repo';
export class D extends DurableObject {
  fetch() {
    const db = makeDrizzle(this.ctx.storage);
    return Response.json([
      listProducts(db, 's', 24),
      addCartItem(db, 's', 'x', 'p', 1),
      createOrder(db, 's', 'x'),
    ]);
  }
}
export default { fetch: () => new Response('ok') };
