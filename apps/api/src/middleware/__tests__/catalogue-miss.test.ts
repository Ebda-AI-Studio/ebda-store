import { describe, it, expect } from 'vitest';
import type { Request, Response } from 'express';
import { catalogueMissRoute, isVerifiedCatalogueMiss } from '../catalogue-miss';
import { setResolvedStoreId } from '../../utils/resolved-store';

const STORE = '11111111-1111-4111-8111-111111111111';
const mkReq = (params: Record<string, string> = {}) => ({ params }) as unknown as Request;
const mkRes = () => ({}) as unknown as Response;
const mark = (route: Parameters<typeof catalogueMissRoute>[0], req: Request, res: Response) =>
  catalogueMissRoute(route)(req, res, () => undefined);

describe('catalogue-miss mark', () => {
  it('exempts a listed route in the resolved store', () => {
    const req = mkReq();
    const res = mkRes();
    setResolvedStoreId(req, STORE);
    mark('GET /public/products/:slugOrId', req, res);
    expect(isVerifiedCatalogueMiss(req, res)).toBe(true);
  });

  it('does not write any property onto the response (no key a request could collide with)', () => {
    const req = mkReq({ storeId: '__proto__' });
    const res = mkRes();
    mark('GET /public/:storeId/blog/:slug', req, res);
    expect(Reflect.ownKeys(res)).toEqual([]);
    expect(({} as Record<string, unknown>).route).toBeUndefined();
  });

  it('a __proto__ / constructor path id is never the resolved store, so it stays counted', () => {
    for (const hostile of ['__proto__', 'constructor']) {
      const req = mkReq({ storeId: hostile });
      const res = mkRes();
      setResolvedStoreId(req, STORE);
      mark('GET /public/:storeId/blog/:slug', req, res);
      expect(isVerifiedCatalogueMiss(req, res)).toBe(false);
    }
  });

  it('an unmarked response is never exempt, even with a resolved store', () => {
    const req = mkReq();
    setResolvedStoreId(req, STORE);
    expect(isVerifiedCatalogueMiss(req, mkRes())).toBe(false);
  });
});
