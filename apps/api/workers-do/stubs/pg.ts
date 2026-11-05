// Test-lane stub for `pg` (vitest.workers-do.config.mts): packages/database/src imports it at module load, and the CommonJS package
// cannot be evaluated by the workerd module runner. The DB-less lane has no Postgres: constructing a client is a test bug.
const gone = (): never => {
  throw new Error('POSTGRES_REMOVED: the workers-do lane has no Postgres (pg is stubbed)');
};
export class Pool {
  constructor() {
    gone();
  }
}
export class Client {
  constructor() {
    gone();
  }
}
export const types = {
  setTypeParser: () => undefined,
  getTypeParser: () => (v: unknown) => v,
  builtins: {},
};
export default { Pool, Client, types };
