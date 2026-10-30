import { ScriptedModel } from "agent-guardrails/src/index.ts";
import { afterAll, describe, expect, inject, it } from "vitest";
import { ask } from "../src/agent.js";
import { Database } from "../src/db.js";
import { introspect, renderSchema } from "../src/schema.js";

const db = new Database(inject("databaseUrl"));
afterAll(() => db.close());
const schema = renderSchema(await introspect(db));

const sql = (s: string) => ({ sql: s });

describe("ask", () => {
  it("explores, submits, and returns the last submitted query with its result", async () => {
    const model = new ScriptedModel([
      { call: [{ name: "run_sql", input: sql("SELECT DISTINCT name FROM teams") }] },
      { call: [{ name: "submit_answer", input: sql("SELECT name FROM players WHERE team_id = 2") }] },
      { call: [{ name: "submit_answer", input: sql("SELECT p.name FROM players p JOIN teams t ON t.id = p.team_id WHERE t.name = 'Harbour FC'") }] },
      { say: "Harbour FC has two players, Ana and Ben." },
    ]);
    const a = await ask(db, "Who plays for Harbour FC?", { schema, chatModel: model });
    expect(a.status).toBe("completed");
    expect(a.sql).toContain("Harbour FC");
    expect(a.result?.rows).toEqual([["Ana"], ["Ben"]]);
    expect(a.text).toMatch(/Ana and Ben/);
    expect(a.queries).toBe(3);
  });

  it("shows the model its query errors so it can fix them", async () => {
    let seen = "";
    const model = new ScriptedModel([
      { call: [{ name: "submit_answer", input: sql("SELECT goal FROM players") }] },
      (results) => {
        seen = results[0]!.content;
        return { call: [{ name: "submit_answer", input: sql("SELECT sum(goals) FROM players") }] };
      },
      { say: "24 goals." },
    ]);
    const a = await ask(db, "How many goals in total?", { schema, chatModel: model });
    expect(seen).toMatch(/column "goal" does not exist/);
    expect(a.result?.rows).toEqual([["24"]]);
  });

  it("blocks writes at the guard, before they reach the database", async () => {
    const model = new ScriptedModel([
      { call: [{ name: "run_sql", input: sql("DELETE FROM players") }] },
      { call: [{ name: "run_sql", input: sql("SELECT 1; DROP TABLE players") }] },
      { call: [{ name: "run_sql", input: sql("UPDATE players SET goals = 0") }] },
    ]);
    const a = await ask(db, "Clear the table.", { schema, chatModel: model });
    expect(a.status).toBe("handed_off");
    expect(a.queries).toBe(0);
    const blocked = a.audit.entries.filter((e) => e.type === "decision" && e.data.allowed !== true);
    expect(blocked).toHaveLength(3);
    expect((await db.query("SELECT count(*) FROM players")).rows).toEqual([["4"]]);
  });

  it("stops a model that never finishes", async () => {
    const model = new ScriptedModel([{ call: [{ name: "run_sql", input: sql("SELECT 1") }] }], { loopLast: true });
    const a = await ask(db, "Loop.", { schema, chatModel: model, maxToolCalls: 4 });
    expect(a.status).toBe("stopped");
    expect(a.queries).toBe(4);
    expect(a.sql).toBeNull();
  });
});
