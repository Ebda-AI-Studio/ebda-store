# Drop the unused legacy app login role (production Neon)

Production's API connects as `ebda_app`. An earlier app login role, created by
migration `20260404000000_add_rls_policies` before the role was renamed, still
exists on the production Neon database and nothing connects as it. This runbook
removes it. It is NOT a migration: applied migrations are immutable, and a
fresh database will still create the role when it replays history, so this is a
one-time operator step on production only.

The role name is held in a psql variable so no retired name appears in the
repository. The operator sets it (the name is `legacy_role` below; the
controller's report states its exact value):

```
\set legacy_role <name of the legacy role>
```

Run read-only checks (1-4) first. Stop at the first check that does not match
its expected result. Everything is run as the database owner, one statement at
a time, against production only after the controller approves.

## 1. Nothing is connected as the role

```sql
SELECT pid, usename, application_name, client_addr, state, backend_start
FROM pg_stat_activity
WHERE usename = :'legacy_role';
-- expected: 0 rows
```

Also confirm no deployed `DATABASE_URL` / Hyperdrive binding / Railway variable
names the role (`ebda_app` must be the only app login). Sample over a day; one
empty read is not proof for a role that only a cron might use.

## 2. The role owns nothing

```sql
SELECT classid::regclass AS catalog, count(*)
FROM pg_shdepend
WHERE refobjid = (SELECT oid FROM pg_roles WHERE rolname = :'legacy_role')
  AND deptype = 'o'
GROUP BY 1;
-- expected: 0 rows
```

If rows come back, hand the objects to the owner first (do not drop them):

```sql
REASSIGN OWNED BY :"legacy_role" TO CURRENT_USER;
```

## 3. No RLS policy depends on the role (the dangerous one)

`DROP OWNED BY` strips the role from every policy that lists it and, as far as
we know from the Postgres source (not re-verified here), drops a policy whose only
role it was, which would silently remove tenant isolation. Treat it as unsafe.

```sql
SELECT schemaname, tablename, policyname, roles
FROM pg_policies
WHERE :'legacy_role' = ANY (roles);
-- expected: 0 rows
```

If any row returns, STOP. Re-point those policies at `ebda_app` in a normal
migration, deploy it, and only then continue. Do NOT run `DROP OWNED BY`.

## 4. Inventory the remaining grants

```sql
SELECT table_schema, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE grantee = :'legacy_role';

SELECT defaclnamespace::regnamespace AS schema, defaclobjtype, defaclacl
FROM pg_default_acl
WHERE defaclacl::text LIKE '%' || :'legacy_role' || '%';
```

## 5. Disable login first (reversible), observe, then remove

```sql
ALTER ROLE :"legacy_role" NOLOGIN;
-- watch error logs / alerts for one full day (crons included). To roll back:
-- ALTER ROLE :"legacy_role" LOGIN;
```

## 6. Revoke, then drop

Only after step 5 produced no failures:

```sql
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM :"legacy_role";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM :"legacy_role";
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM :"legacy_role";
REVOKE ALL ON SCHEMA public FROM :"legacy_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON TABLES FROM :"legacy_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM :"legacy_role";
DROP ROLE :"legacy_role";
```

`DROP ROLE` fails loudly if anything still depends on the role; read the
`DETAIL` lines rather than reaching for `DROP OWNED BY`.

## 7. Verify

```sql
SELECT rolname FROM pg_roles WHERE rolname = :'legacy_role';        -- 0 rows
SELECT current_user, rolbypassrls, rolsuper FROM pg_roles
WHERE rolname = 'ebda_app';                                          -- bypass=f, super=f
SELECT count(*) FROM pg_policies WHERE policyname IS NOT NULL;      -- same count as before step 3
```

Then hit the API `/health` and one tenant-scoped read to confirm RLS still
answers as `ebda_app`.

## Known consequence

A brand-new database that replays migration history will create the legacy role
again (the early migration is immutable). Drop it there too if the
environment is long-lived; this runbook is written for production only.
