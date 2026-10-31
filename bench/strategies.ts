/**
 * The ladder of approaches the benchmark compares, cheapest first. Each one turns a Mini-Dev
 * question into a final SQL string; scoring happens separately, against the gold query.
 *
 *   bird-prompt     BIRD's own fixed baseline prompt, one call. Reproduces the published numbers.
 *   oneshot         Our prompt: schema from the live catalog (comments, example values, row counts).
 *   oneshot-repair  oneshot, then run it; on an error or no rows, show the model and let it fix (twice).
 *   agent           Tool use: explore with run_sql, then submit_answer (see src/agent.ts).
 *   agent-vote3     Three agent runs; the answer whose result most of them agree on wins.
 */
import type { Usage } from "agent-guardrails/src/index.ts";
import { ask } from "../src/agent.js";
import { QueryError, type Database } from "../src/db.js";
import { complete, type Turn } from "../src/llm.js";
import { callCost } from "../src/pricing.js";
import { extractSql } from "../src/sql.js";
import { rowKey } from "../src/values.js";
import type { BaselineRow } from "./bird.js";

export interface Context {
  db: Database;
  model: string;
  /** Rendered catalog schema for this question's database. */
  schema: string;
}

export interface TraceStep {
  tool: string;
  sql?: string;
  ok?: boolean;
  output?: string;
}

export interface Attempt {
  sql: string | null;
  costUsd: number;
  usage: Usage;
  modelCalls: number;
  queries: number;
  status?: string;
  trace?: TraceStep[];
  /** For voting: how many runs agreed with the chosen answer. */
  votes?: number[];
}

/** The output contract from BIRD's baseline prompt, so every strategy is held to the same rules. */
export const OUTPUT_RULES = [
  "- Make sure you only output the information that is asked in the question. If the question asks for a specific column, make sure to only include that column in the SELECT clause, nothing more.",
  "- The generated query should return all of the information asked in the question without any missing or extra information.",
].join("\n");

const zero = (): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

function add(total: Usage, u: Usage): Usage {
  total.inputTokens += u.inputTokens;
  total.outputTokens += u.outputTokens;
  total.cacheReadTokens! += u.cacheReadTokens ?? 0;
  total.cacheWriteTokens! += u.cacheWriteTokens ?? 0;
  return total;
}

async function birdPrompt(q: BaselineRow, ctx: Context): Promise<Attempt> {
  const c = await complete(ctx.model, [{ role: "user", content: q.prompt }]);
  return { sql: extractSql(c.text), costUsd: callCost(ctx.model, c.usage), usage: c.usage, modelCalls: 1, queries: 0 };
}

function oneshotPrompt(q: BaselineRow, ctx: Context): string {
  return [
    `PostgreSQL database schema:\n\n${ctx.schema}`,
    q.evidence ? `Hint: ${q.evidence}` : "",
    `Rules:\n${OUTPUT_RULES}`,
    `Question: ${q.question}`,
    "Think it through, then give the final query in a ```sql code block.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function oneshot(q: BaselineRow, ctx: Context, repairs = 0): Promise<Attempt> {
  const turns: Turn[] = [{ role: "user", content: oneshotPrompt(q, ctx) }];
  const usage = zero();
  let cost = 0;
  let calls = 0;
  let queries = 0;
  const trace: TraceStep[] = [];
  let sql: string | null = null;
  for (let i = 0; ; i++) {
    const c = await complete(ctx.model, turns);
    calls++;
    add(usage, c.usage);
    cost += callCost(ctx.model, c.usage);
    sql = extractSql(c.text);
    if (i >= repairs) break;
    turns.push({ role: "assistant", content: c.text });
    queries++;
    try {
      const r = await ctx.db.query(sql, { timeoutMs: 30_000 });
      trace.push({ tool: "execute", sql, ok: true, output: `${r.rowCount} rows` });
      if (r.rowCount > 0) break;
      turns.push({ role: "user", content: "That query ran but returned no rows. If the answer really is empty, repeat the query unchanged; otherwise fix it. Give the final query in a ```sql block." });
    } catch (err) {
      trace.push({ tool: "execute", sql, ok: false, output: (err as QueryError).message });
      turns.push({ role: "user", content: `That query failed: ${(err as QueryError).message}\n\nFix it and give the final query in a \`\`\`sql block.` });
    }
  }
  return { sql, costUsd: cost, usage, modelCalls: calls, queries, trace };
}

async function agent(q: BaselineRow, ctx: Context): Promise<Attempt> {
  const a = await ask(ctx.db, q.question, {
    schema: ctx.schema,
    model: ctx.model,
    hint: q.evidence || undefined,
    outputRules: OUTPUT_RULES,
  });
  // One step per tool call: what was asked, whether the guard let it through, what came back.
  const trace: TraceStep[] = [];
  const byCall = new Map<string, TraceStep>();
  for (const e of a.audit.entries) {
    const d = e.data as Record<string, unknown>;
    if (e.type === "decision") {
      const step: TraceStep = { tool: String(d.tool), sql: (d.input as { sql?: string } | null)?.sql };
      if (d.allowed !== true) Object.assign(step, { ok: false, output: `blocked (${String(d.code)}): ${String(d.reason)}` });
      byCall.set(String(d.callId), step);
      trace.push(step);
    }
    if (e.type === "tool_result") {
      const step = byCall.get(String(d.callId));
      if (step) Object.assign(step, { ok: Boolean(d.ok), output: String(d.output ?? d.error ?? "").slice(0, 400) });
    }
  }
  return { sql: a.sql, costUsd: a.costUsd, usage: a.usage, modelCalls: a.modelCalls, queries: a.queries, status: a.status, trace };
}

/** Groups runs by the result their query returns and picks the biggest group; ties go to the earliest run. */
export async function vote(db: Database, attempts: Attempt[]): Promise<{ index: number; votes: number[] }> {
  const keys: (string | null)[] = [];
  for (const a of attempts) {
    if (!a.sql) {
      keys.push(null);
      continue;
    }
    try {
      const r = await db.query(a.sql, { timeoutMs: 30_000 });
      keys.push(JSON.stringify([...new Set(r.rows.map((row) => rowKey(row, r.oids)))].sort()));
    } catch {
      keys.push(null);
    }
  }
  const votes = keys.map((k) => (k === null ? 0 : keys.filter((x) => x === k).length));
  const best = Math.max(...votes);
  return { index: best === 0 ? 0 : votes.indexOf(best), votes };
}

async function agentVote(q: BaselineRow, ctx: Context, n = 3): Promise<Attempt> {
  const runs = await Promise.all(Array.from({ length: n }, () => agent(q, ctx)));
  const { index, votes } = await vote(ctx.db, runs);
  const usage = runs.reduce((t, r) => add(t, r.usage), zero());
  return {
    sql: runs[index]!.sql,
    costUsd: runs.reduce((s, r) => s + r.costUsd, 0),
    usage,
    modelCalls: runs.reduce((s, r) => s + r.modelCalls, 0),
    queries: runs.reduce((s, r) => s + r.queries, 0),
    trace: runs[index]!.trace,
    votes,
  };
}

export const STRATEGIES: Record<string, (q: BaselineRow, ctx: Context) => Promise<Attempt>> = {
  "bird-prompt": birdPrompt,
  oneshot: (q, ctx) => oneshot(q, ctx, 0),
  "oneshot-repair": (q, ctx) => oneshot(q, ctx, 2),
  agent,
  "agent-vote3": (q, ctx) => agentVote(q, ctx, 3),
};
