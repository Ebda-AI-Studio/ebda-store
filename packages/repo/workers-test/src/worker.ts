import { DurableObject } from 'cloudflare:workers';
import store0001 from '../../../cf-schema/migrations/store/0001_init.sql';
import store0002 from '../../../cf-schema/migrations/store/0002_invariants.sql';
import meta from '../../../cf-schema/generated/prisma-meta.json';
import { createPrismaLite } from '../../src/prisma-lite/client';
import { doSqlRunner } from '../../src/prisma-lite/do-runner';
import { splitSql } from '../../src/prisma-lite/split-sql';
import type { Meta } from '../../src/prisma-lite/types';

/** A StoreDO stand-in: the real schema, the real runner, prisma-lite on top. */
export class LiteDO extends DurableObject {
  lite: any;
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.transactionSync(() => {
        for (const stmt of [...splitSql(store0001), ...splitSql(store0002)])
          ctx.storage.sql.exec(stmt);
      });
    });
    this.lite = createPrismaLite(meta as unknown as Meta, doSqlRunner(ctx.storage), 'store-do', {
      storeId: 's1',
    });
  }

  async seed(): Promise<void> {
    for (const [id, slug] of [
      ['p1', 'alpha'],
      ['p2', 'beta'],
    ])
      await this.lite.product.create({ data: { id, name: slug, slug, price: 100, inventory: 5 } });
  }
  async names(): Promise<Record<string, string>> {
    return Object.fromEntries(
      (await this.lite.product.findMany({ orderBy: { id: 'asc' } })).map((p: any) => [p.id, p.name])
    );
  }
  async inventory(id: string): Promise<number> {
    return (await this.lite.product.findUnique({ where: { id } })).inventory;
  }
  /** Scenario A: an interactive transaction that updates, waits on a TIMER (real I/O: other requests may run), then throws. */
  async txThatFailsAfterTimer(): Promise<string> {
    try {
      await this.lite.$transaction(async (tx: any) => {
        await tx.product.update({ where: { id: 'p1' }, data: { name: 'IN-TX' } });
        await new Promise(r => setTimeout(r, 50));
        throw new Error('A fails');
      });
      return 'committed';
    } catch (e) {
      return (e as Error).message;
    }
  }
  /** Scenario B: an unrelated write issued by another request while A is open. */
  async unrelatedWrite(): Promise<string> {
    await this.lite.product.update({ where: { id: 'p2' }, data: { name: 'OUTSIDE' } });
    return 'ok';
  }
  async nestedAtomicity(): Promise<string> {
    try {
      await this.lite.product.create({
        data: {
          id: 'half',
          name: 'n',
          slug: 'half',
          price: 1,
          images: {
            create: [
              { id: 'd', url: 'a' },
              { id: 'd', url: 'b' },
            ],
          },
        },
      });
      return 'created';
    } catch (e) {
      return `${(e as any).code}|${JSON.stringify((e as any).meta?.target)}`;
    }
  }
  async exists(id: string): Promise<boolean> {
    return (await this.lite.product.findUnique({ where: { id } })) !== null;
  }
  async caughtInsideTx(): Promise<number> {
    await this.lite.$transaction(async (tx: any) => {
      try {
        await tx.product.create({
          data: {
            id: 'half2',
            name: 'n',
            slug: 'half2',
            price: 1,
            images: {
              create: [
                { id: 'd2', url: 'a' },
                { id: 'd2', url: 'b' },
              ],
            },
          },
        });
      } catch {
        /* swallowed */
      }
      await tx.product.create({ data: { id: 'after', name: 'n', slug: 'after', price: 1 } });
    });
    return this.ctx.storage.sql
      .exec(`SELECT count(*) AS n FROM product_images WHERE id = 'd2'`)
      .one().n as number;
  }
  async foreignStoreWrite(): Promise<string> {
    try {
      await this.lite.product.create({
        data: { id: 'x', storeId: 'OTHER', name: 'n', slug: 'x', price: 1 },
      });
      return 'allowed';
    } catch (e) {
      return (e as Error).message;
    }
  }
}

export default { fetch: () => new Response('prisma-lite do test') };
