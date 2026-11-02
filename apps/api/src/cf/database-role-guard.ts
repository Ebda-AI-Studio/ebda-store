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

/** The slice of a driver adapter the role query needs (structural: `SqlDriverAdapter` satisfies it). */
export interface RoleQueryable {
  queryRaw(q: { sql: string; args: unknown[]; argTypes: unknown[] }): Promise<{
    columnNames: string[];
    rows: unknown[][];
  }>;
}

/** Is the connection role superuser or BYPASSRLS? Read on the request's own connection. */
export async function queryDatabaseRole(db: RoleQueryable): Promise<DatabaseRole[]> {
  const res = await db.queryRaw({
    sql:
      'SELECT current_user::text AS "currentUser", (rolbypassrls OR rolsuper) AS bypass ' +
      'FROM pg_roles WHERE rolname = current_user',
    args: [],
    argTypes: [],
  });
  const iUser = res.columnNames.indexOf('currentUser');
  const iBypass = res.columnNames.indexOf('bypass');
  return res.rows.map(r => ({
    currentUser: String(r[iUser] ?? ''),
    // Anything but a literal false (null, a string) is treated as unsafe by the guard.
    bypass: r[iBypass] as boolean,
  }));
}
