export interface DatabaseRole {
  currentUser: string;
  bypass: boolean;
}

/** Cache only validated success; concurrent first invocations query on their own lease. */
export function createDatabaseRoleGuard(): (query: () => Promise<DatabaseRole[]>) => Promise<void> {
  let validated = false;
  return async query => {
    if (validated) return;
    // Do not store a pending promise: its I/O belongs to the invoking request.
    const rows = await query();
    if (rows.length !== 1 || !rows[0]?.currentUser || rows[0].bypass !== false) {
      throw new Error(
        'Unsafe or unverifiable Hyperdrive database role: configure a non-superuser, ' +
          'NOBYPASSRLS application role before serving traffic.'
      );
    }
    validated = true;
  };
}
