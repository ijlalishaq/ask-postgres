/**
 * pnpm serve    HTTP API over one database (DATABASE_URL), on PORT (default 8787).
 *
 *   POST /ask     {"question": "...", "hint"?: "..."}  ->  sql, columns, rows, answer, cost
 *   GET  /schema  the schema text the model sees
 *   GET  /health
 *
 * Every request's agent run is appended to the hash-chained audit log (AUDIT_LOG, default
 * audit.jsonl), so you can see afterwards exactly which queries ran for which question.
 */
import { serve } from "@hono/node-server";
import { AuditLog, type ChatModel } from "agent-guardrails/src/index.ts";
import { Hono } from "hono";
import { z } from "zod";
import { ask } from "./agent.js";
import { Database } from "./db.js";
import { loadEnv } from "./env.js";
import { MODELS } from "./pricing.js";
import { assertReadOnlyRole } from "./safety.js";
import { introspect, renderSchema } from "./schema.js";

const SCHEMA_TTL_MS = 10 * 60_000;
const MAX_ROWS = 200;

const body = z.object({
  question: z.string().min(1).max(2000),
  hint: z.string().max(2000).optional(),
});

export interface AppOptions {
  model: string;
  auditPath?: string;
  maxCostUsd?: number;
  /** For tests: a scripted model per request. */
  chatModel?: () => ChatModel;
}

export function app(db: Database, opts: AppOptions) {
  let cached: { text: string; at: number } | null = null;
  const schema = async () => {
    if (!cached || Date.now() - cached.at > SCHEMA_TTL_MS) cached = { text: renderSchema(await introspect(db)), at: Date.now() };
    return cached.text;
  };

  const api = new Hono();
  api.get("/health", (c) => c.json({ ok: true, database: db.name }));
  api.get("/schema", async (c) => c.text(await schema()));
  api.post("/ask", async (c) => {
    const parsed = body.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "expected {question: string, hint?: string}" }, 400);
    const runId = crypto.randomUUID();
    const audit = opts.auditPath ? AuditLog.toFile(runId, opts.auditPath) : new AuditLog(runId);
    const a = await ask(db, parsed.data.question, {
      schema: await schema(),
      model: opts.model,
      hint: parsed.data.hint,
      maxCostUsd: opts.maxCostUsd,
      chatModel: opts.chatModel?.(),
      audit,
    });
    return c.json({
      runId,
      status: a.status,
      answer: a.text,
      reason: a.reason,
      sql: a.sql,
      columns: a.result?.columns ?? null,
      rows: a.result?.rows.slice(0, MAX_ROWS) ?? null,
      rowCount: a.result?.rowCount ?? null,
      costUsd: a.costUsd,
      modelCalls: a.modelCalls,
      queries: a.queries,
    });
  });
  return api;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  loadEnv();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("set DATABASE_URL");
  const model = process.env.MODEL ?? "claude-haiku-5-5";
  if (!MODELS.includes(model)) throw new Error(`MODEL must be one of ${MODELS.join(", ")}`);
  const db = new Database(url, 8);
  await assertReadOnlyRole(db, process.env.ALLOW_WRITABLE_ROLE === "1");
  const port = Number(process.env.PORT ?? 8787);
  serve({ fetch: app(db, { model, auditPath: process.env.AUDIT_LOG ?? "audit.jsonl" }).fetch, port });
  console.log(`ask-postgres on http://localhost:${port} (${db.name}, ${model})`);
}
