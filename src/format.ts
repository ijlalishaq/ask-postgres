import type { Result } from "./db.js";

const MAX_CELL = 80;

/** A result as a small text table for the model: header, up to `limit` rows, and the total count. */
export function formatResult(r: Result, limit = 20): string {
  if (r.columns.length === 0) return "(no columns)";
  const cell = (v: string | null) => (v === null ? "NULL" : v.length > MAX_CELL ? `${v.slice(0, MAX_CELL)}...` : v);
  const lines = [r.columns.join(" | "), ...r.rows.slice(0, limit).map((row) => row.map(cell).join(" | "))];
  const shown = Math.min(limit, r.rows.length);
  lines.push(r.rowCount > shown ? `(${r.rowCount} rows, first ${shown} shown)` : `(${r.rowCount} row${r.rowCount === 1 ? "" : "s"})`);
  return lines.join("\n");
}
