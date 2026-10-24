import * as P from './prisma-d1';
export default {
  async fetch(_r: Request, env: { ORM_D1: D1Database }) {
    const p = P.makePrisma(env.ORM_D1);
    return Response.json([
      await P.listProducts(p, 's', 24),
      await P.addCartItem(p, 's', 'x', 'p', 1),
    ]);
  },
};
