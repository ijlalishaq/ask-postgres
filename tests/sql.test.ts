import { describe, expect, it } from "vitest";
import { parseNotes } from "../bench/comments.js";
import { cleanSql, extractSql, readOnlyProblem } from "../src/sql.js";

describe("extractSql", () => {
  it("takes the last sql block", () => {
    const text = "First try:\n```sql\nSELECT 1\n```\nBetter:\n```sql\nSELECT 2;\n```\nDone.";
    expect(extractSql(text)).toBe("SELECT 2");
  });

  it("falls back to an untagged block, then to the whole text", () => {
    expect(extractSql("```\nSELECT 3\n```")).toBe("SELECT 3");
    expect(extractSql("SELECT 4;")).toBe("SELECT 4");
  });

  it("drops leading comment lines", () => {
    expect(cleanSql("-- Your SQL query\n-- second\nSELECT 5")).toBe("SELECT 5");
  });
});

describe("readOnlyProblem", () => {
  it("allows single read statements", () => {
    expect(readOnlyProblem("SELECT 1")).toBeNull();
    expect(readOnlyProblem("with x as (select 1) select * from x;")).toBeNull();
    expect(readOnlyProblem("SELECT ';' AS semi, \"a;b\" FROM t -- done; really")).toBeNull();
  });

  it("refuses writes and stacked statements", () => {
    expect(readOnlyProblem("DELETE FROM t")).toMatch(/only SELECT/);
    expect(readOnlyProblem("SELECT 1; DROP TABLE t")).toMatch(/one statement/);
    expect(readOnlyProblem("  ")).toMatch(/empty/);
  });
});

describe("parseNotes", () => {
  const schema = [
    'CREATE TABLE "customers" (',
    '    "customerid" bigint, -- identification of the customer; example: [3, 5]',
    '    "segment" text, -- client segment; example: [\'SME\', \'LAM\']',
    '    "Currency" text, -- Currency; example: [\'EUR\']',
    '    "notes" text, -- example: []',
    '    PRIMARY KEY ("customerid")',
    ");",
  ].join("\n");

  it("keeps real descriptions and drops ones that only repeat the name", () => {
    expect(parseNotes(schema)).toEqual([
      { table: "customers", column: "customerid", note: "identification of the customer" },
      { table: "customers", column: "segment", note: "client segment" },
    ]);
  });
});
