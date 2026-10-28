/** A platform host label can never become a merchant store through the super-admin edit route either. */
import { describe, it, expect } from 'vitest';
import { isReservedSlug, RESERVED_SLUGS } from '@ebda/shared';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('reserved slugs cover the hosts that serve platform surfaces', () => {
  it.each(['wa', 'accounts', 'api', 'app', 'orders', 'whatsapp', 'status', 'help', 'docs'])(
    '%s is reserved',
    s => {
      expect(isReservedSlug(s)).toBe(true);
      expect((RESERVED_SLUGS as readonly string[]).includes(s)).toBe(true);
    }
  );

  it('the super-admin store edit schema refuses a reserved slug (it used to accept any ^[a-z0-9-]+$)', () => {
    const src = readFileSync(
      resolve(__dirname, '../../apps/api/src/routes/admin.routes.ts'),
      'utf8'
    );
    const schema = src.slice(
      src.indexOf('const updateStoreAdminSchema'),
      src.indexOf('});', src.indexOf('const updateStoreAdminSchema'))
    );
    expect(schema).toMatch(/isReservedSlug\(s\)/);
  });
});
