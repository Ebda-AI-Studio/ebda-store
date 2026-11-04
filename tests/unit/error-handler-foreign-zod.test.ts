/**
 * The "parseChart dual-zod" class (B0-46): a schema from @ebda/shared can throw a ZodError
 * from a different zod module instance (measured under vitest: `instanceof ZodError` false),
 * which errorHandler answered as a 500. size-chart.routes.ts and lib/parse-input.ts worked
 * around it locally; every other `.parse()` of a shared schema did not.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { sizeChartSchema } from '@ebda/shared';
import { errorHandler, clientErrorStatus, isZodError } from '@api/middleware/error-handler';

function sharedSchemaError(): unknown {
  try {
    sizeChartSchema.parse({});
  } catch (e) {
    return e;
  }
  throw new Error('expected the shared schema to reject {}');
}

describe('ZodError detection across zod instances', () => {
  it('recognises a shared-schema ZodError and classifies it 400', () => {
    const err = sharedSchemaError();
    expect(isZodError(err)).toBe(true);
    expect(clientErrorStatus(err)).toBe(400);
  });

  it('errorHandler answers 400 VALIDATION_ERROR with details', async () => {
    const app = express();
    app.get('/x', () => {
      throw sharedSchemaError();
    });
    app.use(errorHandler);
    const res = await request(app).get('/x');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(Object.keys(res.body.error.details).length).toBeGreaterThan(0);
  });

  it('an ordinary Error named something else is not a ZodError', () => {
    expect(isZodError(new Error('boom'))).toBe(false);
    expect(isZodError(Object.assign(new Error('x'), { name: 'ZodError' }))).toBe(false);
  });
});

describe('a duck-typed ZodError whose issues carry no path (review M-1)', () => {
  it('answers 400 with the message under the root key, never 500', async () => {
    const app = express();
    app.get('/x', () => {
      throw Object.assign(new Error('x'), {
        name: 'ZodError',
        issues: [{ message: 'Required' }, { path: ['size', 0], message: 'Too small' }, null],
      });
    });
    app.use(errorHandler);
    const res = await request(app).get('/x');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    // the field map stays; the bilingual sentence rides next to it for the admin's localizer (BE:E-2)
    expect(res.body.error.details).toMatchObject({ '': ['Required'], 'size.0': ['Too small'] });
    expect(res.body.error.details.messageAr).toEqual(expect.any(String));
    expect(res.body.error.details.messageEn).toEqual(expect.any(String));
  });
});
