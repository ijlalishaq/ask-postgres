/**
 * Reads a database's structure from the Postgres catalog and renders it as annotated DDL for the
 * prompt: columns and types, primary and foreign keys, column comments, an approximate row count,
 * and a few example values per column.
 *
 * Examples come from pg_stats (most common values, else histogram bounds), which ANALYZE already
 * collected, so introspection never scans a table. Showing the model real values is one of the
 * cheapest accuracy wins in text-to-SQL: it learns that a column holds 'CZE' rather than 'Czech
 * Republic' before it writes a WHERE clause.
 */
import type { Database } from "./db.js";

export interface Column {
  name: string;
  type: string;
  comment: string | null;
  examples: string[];
}

export interface Table {
  name: string;
  rows: number;
  columns: Column[];
  primaryKey: string[];
  foreignKeys: { columns: string[]; refTable: string; refColumns: string[] }[];
}

const TABLES = `
SELECT c.oid, c.relname AS name, greatest(c.reltuples, 0)::bigint AS rows
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
ORDER BY c.relname`;

const COLUMNS = `
SELECT a.attrelid AS oid, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
       col_description(a.attrelid, a.attnum) AS comment,
       (SELECT array_to_json(coalesce(s.most_common_vals, s.histogram_bounds)::text::text[])
          FROM pg_stats s
         WHERE s.schemaname = 'public' AND s.tablename = c.relname AND s.attname = a.attname) AS examples
FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm') AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attrelid, a.attnum`;

const KEYS = `
SELECT con.conrelid AS oid, con.contype AS kind,
       array_to_json(ARRAY(SELECT attname FROM unnest(con.conkey) WITH ORDINALITY k(n, i)
                           JOIN pg_attribute ON attrelid = con.conrelid AND attnum = k.n ORDER BY k.i)) AS cols,
       ref.relname AS ref_table,
       array_to_json(ARRAY(SELECT attname FROM unnest(con.confkey) WITH ORDINALITY k(n, i)
                           JOIN pg_attribute ON attrelid = con.confrelid AND attnum = k.n ORDER BY k.i)) AS ref_cols
FROM pg_constraint con LEFT JOIN pg_class ref ON ref.oid = con.confrelid
WHERE con.connamespace = 'public'::regnamespace AND con.contype IN ('p', 'f')`;

const MAX_EXAMPLES = 3;
const MAX_EXAMPLE_CHARS = 60;

export async function introspect(db: Database): Promise<Table[]> {
  const [tables, columns, keys] = await Promise.all([db.query(TABLES), db.query(COLUMNS), db.query(KEYS)]);
  const byOid = new Map<string, Table>();
  for (const [oid, name, rows] of tables.rows) {
    byOid.set(oid!, { name: name!, rows: Number(rows), columns: [], primaryKey: [], foreignKeys: [] });
  }
  for (const [oid, name, type, comment, examples] of columns.rows) {
    const t = byOid.get(oid!);
    if (!t) continue;
    const values = (examples ? (JSON.parse(examples) as (string | null)[]) : []).filter(
      (v): v is string => v !== null && v.length <= MAX_EXAMPLE_CHARS,
    );
    t.columns.push({ name: name!, type: type!, comment: comment ?? null, examples: values.slice(0, MAX_EXAMPLES) });
  }
  for (const [oid, kind, cols, refTable, refCols] of keys.rows) {
    const t = byOid.get(oid!);
    if (!t) continue;
    if (kind === "p") t.primaryKey = JSON.parse(cols!);
    else t.foreignKeys.push({ columns: JSON.parse(cols!), refTable: refTable!, refColumns: JSON.parse(refCols!) });
  }
  return [...byOid.values()];
}

export const quoteIdent = (s: string) => (/^[a-z_][a-z0-9_]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`);

const NUMERIC_TYPES = /^(smallint|integer|bigint|real|double precision|numeric.*)$/;

function example(v: string, type: string): string {
  return NUMERIC_TYPES.test(type) ? v : `'${v.replace(/'/g, "''")}'`;
}

export function renderTable(t: Table): string {
  const lines = t.columns.map((c) => {
    const notes = [c.comment, c.examples.length ? `e.g. ${c.examples.map((v) => example(v, c.type)).join(", ")}` : null]
      .filter(Boolean)
      .join("; ");
    return `  ${quoteIdent(c.name)} ${c.type}${notes ? `, -- ${notes}` : ","}`;
  });
  if (t.primaryKey.length) lines.push(`  PRIMARY KEY (${t.primaryKey.map(quoteIdent).join(", ")}),`);
  for (const fk of t.foreignKeys) {
    lines.push(
      `  FOREIGN KEY (${fk.columns.map(quoteIdent).join(", ")}) REFERENCES ${quoteIdent(fk.refTable)} (${fk.refColumns.map(quoteIdent).join(", ")}),`,
    );
  }
  const last = lines.length - 1;
  if (last >= 0) lines[last] = lines[last]!.replace(/,( -- |$)/, "$1");
  return `CREATE TABLE ${quoteIdent(t.name)} ( -- about ${t.rows.toLocaleString("en-US")} rows\n${lines.join("\n")}\n);`;
}

export function renderSchema(tables: Table[]): string {
  return tables.map(renderTable).join("\n\n");
}

/** One line per table, for databases too big to put in the prompt whole. */
export function renderTableList(tables: Table[]): string {
  return tables.map((t) => `${quoteIdent(t.name)} (about ${t.rows.toLocaleString("en-US")} rows): ${t.columns.map((c) => quoteIdent(c.name)).join(", ")}`).join("\n");
}
