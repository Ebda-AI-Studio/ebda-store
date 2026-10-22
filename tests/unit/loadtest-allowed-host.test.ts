/**
 * Review M-6: the storefront search load test writes the search log and spends the Workers AI
 * query-embed budget, so it must never reach production. A denylist (`api.ebda.app`) missed
 * `<slug>.ebda.app`, merchant custom domains and the production `workers.dev` host, so the scenario
 * now uses an ALLOWLIST: localhost, plus the exact hosts named in LOADTEST_ALLOWED_HOSTS. A
 * production host is refused even if someone lists it.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain k6 ES module, no types
import { assertAllowedHost } from '../../loadtests/scenarios/lib/allowed-host.js';

const ok = (base: string, extra = '') => expect(() => assertAllowedHost(base, extra)).not.toThrow();
const no = (base: string, extra = '') => expect(() => assertAllowedHost(base, extra)).toThrow();

describe('storefront-search load test host allowlist', () => {
  it('allows local hosts', () => {
    ok('http://localhost:4000/api/v1');
    ok('http://127.0.0.1:56340/api/v1');
    ok('http://[::1]:4000/api/v1');
  });
  it('refuses production in every shape the old denylist missed', () => {
    no('https://api.ebda.app/api/v1');
    no('https://ebda.app/api/v1');
    no('https://some-shop.ebda.app/api/v1');
    no('https://shop.merchant-domain.com/api/v1');
    no('https://ebda-api.some-account.workers.dev/api/v1');
  });
  it('refuses lookalikes and credentials tricks', () => {
    no('http://localhost.evil.com/api/v1');
    no('http://localhost@evil.com/api/v1');
    no('http://127.0.0.1.evil.com/api/v1');
    no('not a url');
    no('');
  });
  it('allows only the exact preview host named in the allowlist', () => {
    no('https://preview-123.ebda-api.workers.dev/api/v1');
    ok('https://preview-123.ebda-api.workers.dev/api/v1', 'preview-123.ebda-api.workers.dev');
    ok('https://p.example/api/v1', 'a.example, p.example');
    no('https://other.example/api/v1', 'p.example');
  });
  it('refuses a production host even when it is allowlisted', () => {
    no('https://api.ebda.app/api/v1', 'api.ebda.app');
    no('https://ebda.app/api/v1', 'ebda.app');
  });
});
