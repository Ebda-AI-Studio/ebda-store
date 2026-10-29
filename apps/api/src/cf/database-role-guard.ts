export interface DatabaseRole {
  currentUser: string;
  bypass: boolean;
  /**
   * The role owns a public table that has RLS enabled but not FORCEd. A table owner is exempt from its own RLS
   * unless FORCE ROW LEVEL SECURITY is set, so an owner role with NOBYPASSRLS (the migration role, say) reads every
   * store (Ruling F9-ROLE-1).
   */
  ownsUnforcedRls: boolean;
}

/** Cache only validated success; concurrent first invocations query on their own lease. */
export function createDatabaseRoleGuard(): (query: () => Promise<DatabaseRole[]>) => Promise<void> {
  let validated = false;
  return async query => {
    if (validated) return;
    // Do not store a pending promise: its I/O belongs to the invoking request.
    const rows = await query();
    if (
      rows.length !== 1 ||
      !rows[0]?.currentUser ||
      rows[0].bypass !== false ||
      rows[0].ownsUnforcedRls !== false
    ) {
      throw new Error(
        'Unsafe or unverifiable Hyperdrive database role: configure a non-superuser, ' +
          'NOBYPASSRLS application role that owns no un-FORCEd RLS table before serving traffic.'
      );
    }
    validated = true;
  };
}
