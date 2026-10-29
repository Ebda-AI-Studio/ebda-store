import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { exportJWK, generateKeyPair } from 'jose';
import path from 'node:path';

// Tests run INSIDE workerd (Miniflare) against the real app and a real local D1. A throwaway ES256 key and AES key
// are generated per run; nothing here is a production secret.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(privateKey)), kid: 'test-key-1', alg: 'ES256', use: 'sig' };
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          // The service bindings in wrangler.jsonc point at ebda-api; tests inject their own fakes through the app
          // environment (test/helpers.ts), so this stub only has to exist for the runtime to start.
          workers: [
            {
              name: 'ebda-api',
              compatibilityDate: '2026-08-01',
              modules: true,
              script: `import { WorkerEntrypoint } from 'cloudflare:workers';
                export class StoreDirectory extends WorkerEntrypoint { async storesForUser() { return []; } }
                export class IdentityMailer extends WorkerEntrypoint { async sendCode() {} }
                export default { fetch() { return new Response('stub'); } };`,
            },
            {
              // wrangler.jsonc binds WHATSAPP_OTP to ebda-wa; workerd refuses to start with a binding to a missing service. Tests inject their own fake (test/helpers.ts).
              name: 'ebda-wa',
              compatibilityDate: '2026-08-01',
              modules: true,
              script: `import { WorkerEntrypoint } from 'cloudflare:workers';
                export class PlatformOtp extends WorkerEntrypoint { async sendCode() { return { ok: false, reason: 'disabled' }; } }
                export default { fetch() { return new Response('stub'); } };`,
            },
          ],
          bindings: {
            TEST_MIGRATIONS: migrations,
            JWT_PRIVATE_JWK: JSON.stringify(jwk),
            MFA_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
            CLIENT_SECRET_PEPPER: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
              'base64'
            ),
            ORIGIN_PRODUCTS:
              'https://store.ebda.app=store,https://orders.ebda.app=store,https://wa.ebda.app=whatsapp',
            ALLOWED_ORIGINS: 'https://store.ebda.app,https://orders.ebda.app,https://wa.ebda.app',
          },
        },
      }),
    ],
    test: { include: ['test/**/*.test.ts'], testTimeout: 60_000, setupFiles: ['./test/setup.ts'] },
  };
});
