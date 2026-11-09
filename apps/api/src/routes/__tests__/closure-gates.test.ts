import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Source-level guard: the middleware chain declared for `<routerVar>.<method>('<path>'` up to its handler.
// (Importing the routers needs the generated database client; the chain is what these rows are about.)
function chain(file: string, routerVar: string, method: string, path: string): string {
  const src = readFileSync(join(__dirname, '..', file), 'utf8');
  const head = `${routerVar}.${method}(\n  '${path}'`;
  const i = src.indexOf(head);
  if (i < 0) throw new Error(`route ${method} ${path} not found in ${file}`);
  const end = src.indexOf('async (req', i);
  return src.slice(i, end);
}

describe('closure gates (BE:S-11, BE:S-29)', () => {
  it('BE:S-11: staff DELETE /:userId requires MFA enrolment', () => {
    expect(chain('staff.routes.ts', 'router', 'delete', '/:userId')).toContain(
      'requireMfaEnrolled'
    );
  });
  it('BE:S-11: staff DELETE /invites/:inviteId requires MFA enrolment', () => {
    expect(chain('staff.routes.ts', 'router', 'delete', '/invites/:inviteId')).toContain(
      'requireMfaEnrolled'
    );
  });
  it('BE:S-29: public loyalty my-points is feature-gated', () => {
    expect(
      chain('loyalty.routes.ts', 'publicRouter', 'get', '/:storeId/loyalty/my-points')
    ).toContain("requireFeature('loyalty')");
  });
});
