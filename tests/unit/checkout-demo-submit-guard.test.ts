import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { join } from 'node:path';
import {
  code,
  containsCall,
  findFunction,
  hasTopLevelReturn,
  indexOfStatement,
  isIfWithCondition,
  parseFile,
  statementsOf,
  thenStatements,
} from './helpers/ast-query';

/**
 * Wiring test (house style for the huge CheckoutClient: 3000 lines of hooks, no DOM in this repo, so it cannot be
 * rendered): the demo guard is a TOP-LEVEL statement of handleSubmit, after the step-1 advance and before the
 * statement that calls the order API, and it returns. Structural (AST), so a guard in another branch, a commented
 * guard or a window that catches a neighbour cannot satisfy it.
 */
describe('CheckoutClient.handleSubmit on a demo store', () => {
  const sf = parseFile(join(__dirname, '../../apps/web/src/app/checkout/CheckoutClient.tsx'));
  const statements = statementsOf(findFunction(sf, 'handleSubmit'));

  it('returns before createOrder, after step 1 may advance', () => {
    const advance = indexOfStatement(statements, s => containsCall(s, 'setStep', '2'));
    const guard = indexOfStatement(statements, s => isIfWithCondition(s, 'store.isDemo'));
    const order = indexOfStatement(statements, s => containsCall(s, 'api.createOrder'));
    expect(advance).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(advance);
    expect(order).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(order);
    const g = statements[guard] as ts.IfStatement;
    expect(hasTopLevelReturn(thenStatements(g)), code(g)).toBe(true);
  });
});
