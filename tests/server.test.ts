import { ScriptedModel } from "agent-guardrails/src/index.ts";
import { afterAll, describe, expect, inject, it } from "vitest";
import { Database } from "../src/db.js";
import { assertReadOnlyRole, writablePrivileges } from "../src/safety.js";
import { app } from "../src/server.js";

const url = inject("databaseUrl");
const reader = new Database(url);
const admin = new Database(url.replace("asker@", "postgres@"));
afterAll(async () => {
  await reader.close();
  await admin.close();
});

describe("role check", () => {
  it("accepts the read-only role and refuses a superuser", async () => {
    expect(await writablePrivileges(reader)).toEqual([]);
    await expect(assertReadOnlyRole(reader)).resolves.toBeUndefined();
    expect(await writablePrivileges(admin)).toContain("superuser");
    await expect(assertReadOnlyRole(admin)).rejects.toThrow(/can write/);
  });
});

describe("HTTP API", () => {
  const api = app(reader, {
    model: "claude-haiku-5-5",
    chatModel: () =>
      new ScriptedModel([
        { call: [{ name: "submit_answer", input: { sql: "SELECT name FROM teams ORDER BY id" } }] },
        { say: "Two teams: Harbour FC and Ridge United." },
      ]),
  });

  it("answers a question with the SQL and rows", async () => {
    const res = await api.request("/ask", { method: "POST", body: JSON.stringify({ question: "Which teams are there?" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      status: "completed",
      sql: "SELECT name FROM teams ORDER BY id",
      columns: ["name"],
      rows: [["Harbour FC"], ["Ridge United"]],
      rowCount: 2,
      answer: "Two teams: Harbour FC and Ridge United.",
    });
  });

  it("rejects a bad body", async () => {
    const res = await api.request("/ask", { method: "POST", body: JSON.stringify({ q: 1 }) });
    expect(res.status).toBe(400);
  });

  it("serves the schema", async () => {
    const res = await api.request("/schema");
    expect(await res.text()).toContain("CREATE TABLE teams");
  });
});
