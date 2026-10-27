import { afterAll, describe, expect, inject, it } from "vitest";
import { Database, QueryError } from "../src/db.js";
import { introspect, renderSchema } from "../src/schema.js";

const db = new Database(inject("databaseUrl"));
afterAll(() => db.close());

const refusal = (sql: string, opts = {}) =>
  db.query(sql, opts).then(
    () => null,
    (e: QueryError) => e.kind,
  );

describe("Database", () => {
  it("returns raw values, column types and duplicate column names", async () => {
    const r = await db.query("SELECT name, goals, rating, salary, joined, name FROM players WHERE id = 1");
    expect(r.columns).toEqual(["name", "goals", "rating", "salary", "joined", "name"]);
    expect(r.rows).toEqual([["Ana", "12", "7.5", "1200.50", "2021-08-01", "Ana"]]);
    expect(r.oids).toEqual([25, 23, 700, 1700, 1082, 25]);
  });

  it("refuses writes, even ones hidden behind a read", async () => {
    expect(await refusal("DELETE FROM players")).toBe("error");
    expect(await refusal("CREATE TABLE x (a int)")).toBe("error");
    expect(await refusal("SELECT 1; DROP TABLE players")).toBe("syntax");
    expect(await refusal("WITH gone AS (DELETE FROM players RETURNING *) SELECT count(*) FROM gone")).toBe("error");
    expect((await db.query("SELECT count(*) FROM players")).rows).toEqual([["4"]]);
  });

  it("stops slow and expensive queries", async () => {
    expect(await refusal("SELECT pg_sleep(1)", { timeoutMs: 100 })).toBe("timeout");
    expect(await refusal("SELECT * FROM generate_series(1, 1e9) a, generate_series(1, 1e9) b", { maxCost: 1e6 })).toBe(
      "too_expensive",
    );
  });

  it("caps the rows handed back but reports the full count", async () => {
    const r = await db.query("SELECT id FROM players ORDER BY id", { maxRows: 2 });
    expect(r.rows).toEqual([["1"], ["2"]]);
    expect(r.rowCount).toBe(4);
  });
});

describe("introspect", () => {
  it("renders keys, comments and example values from the catalog", async () => {
    const schema = renderSchema(await introspect(db));
    expect(schema).toContain("CREATE TABLE players ( -- about 4 rows");
    expect(schema).toContain("rating real, -- average match rating, 0 to 10; e.g. 7.5");
    expect(schema).toContain("FOREIGN KEY (team_id) REFERENCES teams (id)");
    expect(schema).toContain(`"Home City" text`);
    expect(schema).toContain("PRIMARY KEY (id)");
  });
});
