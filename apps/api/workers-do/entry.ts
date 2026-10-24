// Test worker for the DB-less workerd lane (vitest.workers-do.config.mts): the real StoreDO class from
// SOURCE (not the 11 MB built bundle), so DO + R2 + D1 integration tests run in seconds with no Postgres.
export { StoreDO } from '../src/cf/store-do/store-do';
export default {
  fetch() {
    return new Response('workers-do test worker');
  },
};
