import type { Database } from "./db.js";

/**
 * Checks the role behind DATABASE_URL before serving anything. Every query already runs in a
 * READ ONLY transaction, so this isn't the only line of defence, but a role that can write is a
 * misconfiguration worth refusing loudly: one bug or one SET away from damage.
 */
export async function writablePrivileges(db: Database): Promise<string[]> {
  const r = await db.query(`
    SELECT format('%s on %s', p.privilege, c.relname)
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS p(privilege)
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND c.relkind IN ('r', 'p')
      AND has_table_privilege(c.oid, p.privilege)
    UNION ALL
    SELECT 'CREATE on schema ' || nspname FROM pg_namespace
    WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' AND has_schema_privilege(oid, 'CREATE')
    UNION ALL
    SELECT 'superuser' FROM pg_roles WHERE rolname = current_user AND rolsuper
    LIMIT 10`);
  return r.rows.map((row) => row[0]!);
}

export async function assertReadOnlyRole(db: Database, allowWritable = false): Promise<void> {
  const found = await writablePrivileges(db);
  if (!found.length) return;
  const msg = `the database role can write (${found.join(", ")}). Connect as a read-only role; see README.`;
  if (!allowWritable) throw new Error(msg);
  console.warn(`warning: ${msg}`);
}
