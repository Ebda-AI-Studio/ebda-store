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

let reporter: (err: unknown) => void = err =>
  // eslint-disable-next-line no-console
  console.error('[tx-hooks] an after-commit hook FAILED (the transaction already committed)', err);

/** The app installs its logger / alerting here; the default logs to the console. NEVER a silent swallow (Ruling NZ-D19). */
export function setCommitHookErrorReporter(fn: (err: unknown) => void): void {
  reporter = fn;
}

/**
 * Run and clear a committed transaction's hooks. One failing hook must not stop the others and cannot undo the commit, but it is
 * REPORTED (logged by default, the app's logger / alert when installed), never swallowed.
 */
export async function runCommitHooks(hooks: Array<() => unknown>): Promise<void> {
  for (const hook of hooks.splice(0)) {
    try {
      await hook();
    } catch (err) {
      try {
        reporter(err);
      } catch {
        // a throwing reporter must not break the remaining hooks
      }
    }
  }
}
