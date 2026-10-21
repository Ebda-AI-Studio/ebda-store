import type { NextFunction, Request, Response } from 'express';
import { assertNotDemoStore } from '../services/plan-limit.service';

/**
 * Ruling B1-13 for the public `/:storeId/...` writes (affiliate apply, push subscribe): the
 * demo showroom refuses them with 403 `DEMO_STORE`. Mounted BEFORE the feature gate so the
 * visitor gets the demo message, not a plan message. Unknown store ids pass through.
 */
export function refuseDemoStore(req: Request, _res: Response, next: NextFunction): void {
  assertNotDemoStore(req.params.storeId).then(() => next(), next);
}
