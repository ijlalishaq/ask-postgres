/**
 * Column descriptions from BIRD's documentation, as they appear in the baseline schema text:
 *
 *   "segment" text, -- client segment; example: ['SME', 'LAM']
 *
 * The restore turns them into COMMENT ON COLUMN, so the database documents itself the way a
 * well-kept production database does, and the agent finds them in the catalog like any other.
 * Descriptions that only repeat the column name are dropped.
 */
export interface ColumnNote {
  table: string;
  column: string;
  note: string;
}

const TABLE = /^CREATE TABLE "([^"]+)" \($/;
const COLUMN = /^\s+"([^"]+)" [^,]+, -- (.*)$/;

export function parseNotes(schema: string): ColumnNote[] {
  const notes: ColumnNote[] = [];
  let table: string | null = null;
  for (const line of schema.split("\n")) {
    const t = TABLE.exec(line);
    if (t) {
      table = t[1]!;
      continue;
    }
    const c = table ? COLUMN.exec(line) : null;
    if (!c || !table) continue;
    const note = c[2]!.replace(/;?\s*example: \[.*\]$/, "").trim();
    if (!note || squash(note) === squash(c[1]!)) continue;
    notes.push({ table, column: c[1]!, note });
  }
  return notes;
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function commentSql(n: ColumnNote): string {
  return `COMMENT ON COLUMN ${ident(n.table)}.${ident(n.column)} IS ${literal(n.note)}`;
}
