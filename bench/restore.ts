/**
 * pnpm bench:restore: loads the Mini-Dev dumps into Postgres, one database per BIRD db_id,
 * the way the official image's init script does, and creates the read-only role the agent uses.
 *
 * Needs pg_restore on PATH (it ships with the Postgres client tools).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { ADMIN_URL } from "../scripts/pg.js";
import { DATABASES, DUMPS, SCHEMA_TEXT } from "./bird.js";
import { commentSql, parseNotes } from "./comments.js";

export const READER = "asker";

function urlFor(db: string, base = process.env.ADMIN_DATABASE_URL ?? ADMIN_URL): string {
  const u = new URL(base);
  u.pathname = `/${db}`;
  return u.toString();
}

async function main(): Promise<void> {
  const admin = new pg.Client({ connectionString: urlFor("postgres") });
  await admin.connect();
  const schemas = JSON.parse(readFileSync(SCHEMA_TEXT, "utf8")) as Record<string, string>;
  const existing = new Set((await admin.query("SELECT datname FROM pg_database")).rows.map((r) => r.datname as string));

  const role = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [READER]);
  if (!role.rowCount) await admin.query(`CREATE ROLE ${READER} LOGIN`);
  // Belt and braces: the agent's connection also opens every transaction READ ONLY itself.
  await admin.query(`ALTER ROLE ${READER} SET default_transaction_read_only = on`);

  for (const db of DATABASES) {
    if (existing.has(db)) {
      console.log(`${db}: exists, skipping`);
      continue;
    }
    if (!schemas[db]) throw new Error(`no schema text for ${db}`);
    const t0 = Date.now();
    await admin.query(`CREATE DATABASE ${db} ENCODING 'UTF8' LOCALE 'en_US.utf8' TEMPLATE template0`);
    await admin.query(`ALTER DATABASE ${db} SET timezone = 'Asia/Hong_Kong'`);
    // Sums over real (float4) columns depend on the order rows are added, and a parallel plan
    // changes that order from run to run with load. Without this a few answers flip between
    // right and wrong when scored twice.
    await admin.query(`ALTER DATABASE ${db} SET max_parallel_workers_per_gather = 0`);
    const r = spawnSync(
      "pg_restore",
      ["--exit-on-error", "--no-owner", "--no-acl", "-d", urlFor(db), resolve(DUMPS, `${db}.dump`)],
      { stdio: "inherit" },
    );
    if (r.status) throw new Error(`pg_restore failed for ${db}`);

    const c = new pg.Client({ connectionString: urlFor(db) });
    await c.connect();
    await c.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
    await c.query(`GRANT CONNECT ON DATABASE ${db} TO ${READER}`);
    await c.query(`GRANT USAGE ON SCHEMA public TO ${READER}`);
    await c.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${READER}`);
    const notes = parseNotes(schemas[db]);
    for (const n of notes) await c.query(commentSql(n));
    await c.query("ANALYZE");
    await c.end();
    console.log(`${db}: restored in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${notes.length} column comments`);
  }
  await admin.end();
}

await main();
