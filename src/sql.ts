/** Pulls the query out of a model's answer: the last ```sql block, else the last code block, else the text. */
export function extractSql(text: string): string {
  const blocks = [...text.matchAll(/```(\w*)\s*\n([\s\S]*?)```/g)];
  const sql = blocks.filter((b) => b[1]!.toLowerCase() === "sql").at(-1) ?? blocks.at(-1);
  return cleanSql(sql ? sql[2]! : text);
}

/** Trims whitespace, leading comment lines and trailing semicolons. */
export function cleanSql(sql: string): string {
  return sql
    .replace(/^(\s*--[^\n]*\n)+/, "")
    .trim()
    .replace(/;+\s*$/, "")
    .trim();
}

/**
 * A quick check that a query is a single read statement, used as a guard rule so the model gets a
 * clear error early. It is not the security boundary; the read-only transaction and role are.
 */
export function readOnlyProblem(sql: string): string | null {
  const s = cleanSql(sql);
  if (!s) return "empty query";
  if (!/^(select|with|values|table|explain)\b/i.test(s)) return "only SELECT queries are allowed";
  const body = s.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*|\/\*[\s\S]*?\*\//g, "");
  if (body.includes(";")) return "send one statement at a time";
  return null;
}
