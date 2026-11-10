/** A platform host label can never become a merchant store through the super-admin edit route either. */
import { describe, it, expect } from 'vitest';
import { isReservedSlug, RESERVED_SLUGS } from '@ebda/shared';
import ts from 'typescript';
import { code, nodesOf, parseFile } from './helpers/ast-query';
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
    // Structural, not behavioural: the schema is a module-private const of a router file that boots the whole
    // admin router; scoped to the `slug` property of THAT schema's z.object, comments excluded.
    const sf = parseFile(resolve(__dirname, '../../apps/api/src/routes/admin.routes.ts'));
    const decl = nodesOf(sf).find(
      (n): n is ts.VariableDeclaration =>
        ts.isVariableDeclaration(n) && code(n.name) === 'updateStoreAdminSchema'
    )!;
    expect(decl).toBeDefined();
    const slug = nodesOf(decl.initializer!).find(
      (n): n is ts.PropertyAssignment => ts.isPropertyAssignment(n) && code(n.name) === 'slug'
    )!;
    expect(slug).toBeDefined();
    const refines = nodesOf(slug.initializer).filter(
      (n): n is ts.CallExpression =>
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === 'refine'
    );
    expect(refines.map(r => code(r.arguments[0]))).toContain('s => !isReservedSlug(s)');
  });
});
