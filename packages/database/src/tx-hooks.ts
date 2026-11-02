/**
 * After-COMMIT hooks bound to ONE specific transaction object (Ruling NZ-D19).
 *
 * `afterTenantTxCommit` (index.ts) attaches to the AMBIENT tenant transaction. A caller that passes a DIFFERENT transaction (a
 * `withMoneyTx` / `prisma.$transaction` of its own, which Prisma opens on another connection) must not have its side effect fire when
 * the ambient one commits: that transaction can roll back while the outer one commits. So a hook is registered against the exact
 * transaction object it belongs to, runs only when THAT transaction commits, and is dropped when it rolls back. A transaction with
 * no registry (not opened by `runInTenantContext` / `withMoneyTx`) refuses the hook, and the caller decides (fail closed).
 */
const registry = new WeakMap<object, Array<() => unknown>>();

export function registerTxHooks(tx: object, hooks: Array<() => unknown>): void {
  if (!registry.has(tx)) registry.set(tx, hooks);
}

/** Register `fn` to run after `tx` COMMITS. Returns false (registering nothing) when `tx` has no hook registry. */
export function afterTxCommit(tx: object, fn: () => unknown): boolean {
  const hooks = registry.get(tx);
  if (!hooks) return false;
  hooks.push(fn);
  return true;
}

/** Run and clear a committed transaction's hooks. A throw is swallowed: the transaction already committed. */
export async function runCommitHooks(hooks: Array<() => unknown>): Promise<void> {
  for (const hook of hooks.splice(0)) {
    try {
      await hook();
    } catch {
      // the hook owns its own error reporting
    }
  }
}
