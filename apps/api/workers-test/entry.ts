// The vitest test worker's own entry: it serves nothing. Tests reach the built API Worker through
// the `API` service binding (vitest.workers.config.mts).
export default {
  fetch(): Response {
    return new Response('test worker');
  },
};
