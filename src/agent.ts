/**
 * The agent: Claude with two tools, run_sql to look at the data and submit_answer to hand in the
 * final query, inside agent-guardrails. The guard checks every call (single read statement only,
 * tool and cost budgets) and writes the audit log; the database layer enforces read-only on its own.
 */
import {
  AnthropicModel,
  AuditLog,
  defineTool,
  runAgent,
  setPrice,
  type ChatModel,
  type Policy,
  type Usage,
} from "agent-guardrails/src/index.ts";
import { z } from "zod";
import { QueryError, type Database, type Result } from "./db.js";
import { formatResult } from "./format.js";
import { callCost } from "./pricing.js";
import { readOnlyProblem } from "./sql.js";

// Flat rates so the guard can enforce a cost budget; reports use the exact, tiered cost from pricing.ts.
setPrice("anthropic:claude-haiku-5-5", { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 });
setPrice("anthropic:claude-sonnet-5-5", { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
setPrice("anthropic:claude-opus-5-5", { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });

export interface AskOptions {
  /** Schema text for the prompt, usually renderSchema(await introspect(db)). */
  schema: string;
  model?: string;
  /** Lets tests and evals swap in a scripted model. */
  chatModel?: ChatModel;
  /** Extra domain knowledge for this question, like BIRD's "evidence". */
  hint?: string;
  /** Rules the final query's output must follow, e.g. "only the columns asked for". */
  outputRules?: string;
  maxCostUsd?: number;
  maxToolCalls?: number;
  audit?: AuditLog;
}

export interface Answer {
  /** The last query submitted, or null if the agent never submitted one. */
  sql: string | null;
  result: Result | null;
  text: string;
  status: "completed" | "handed_off" | "stopped";
  reason?: string;
  costUsd: number;
  usage: Usage;
  modelCalls: number;
  queries: number;
  audit: AuditLog;
}

const sqlInput = z.object({
  sql: z.string().describe("One PostgreSQL SELECT statement."),
});

const INSTRUCTIONS = `You answer questions about a PostgreSQL database by writing SQL.

Look before you commit. Use run_sql to check how values are actually spelled and formatted, what a
column really holds, and whether a join multiplies rows. Keep exploratory queries small (LIMIT,
aggregates); they are capped in cost and time.

When you have the query that answers the question, call submit_answer with it. It runs the query
and shows you the first rows. If they look wrong, fix the query and submit again; only the last
submission counts. Then reply with one or two sentences that answer the question in words.

Identifiers with capitals, spaces or punctuation need double quotes, e.g. "Academic Year".`;

export async function ask(db: Database, question: string, opts: AskOptions): Promise<Answer> {
  const modelId = opts.model ?? "claude-haiku-5-5";
  const model = opts.chatModel ?? new AnthropicModel({ model: modelId });
  const audit = opts.audit ?? new AuditLog(crypto.randomUUID());
  let submitted: { sql: string; result: Result | null } | null = null;
  let queries = 0;

  const run = async (sql: string, explore: boolean): Promise<string> => {
    queries++;
    try {
      const r = await db.query(sql, explore ? { timeoutMs: 10_000, maxCost: 5_000_000, maxRows: 50 } : { timeoutMs: 30_000 });
      if (!explore) submitted = { sql, result: r };
      return formatResult(r);
    } catch (err) {
      if (!explore) submitted = { sql, result: null };
      const e = err as QueryError;
      throw new Error(e.kind === "timeout" ? "query timed out; make it cheaper" : e.message);
    }
  };

  const tools = [
    defineTool({
      name: "run_sql",
      description: "Run an exploratory read-only query and see up to 20 rows. Use it to check values, formats and joins.",
      effect: "read",
      input: sqlInput,
      run: ({ sql }) => run(sql, true),
    }),
    defineTool({
      name: "submit_answer",
      description: "Submit the final query that answers the question. It is run and the first rows are shown. Submitting again replaces it.",
      effect: "read",
      input: sqlInput,
      run: ({ sql }) => run(sql, false),
    }),
  ];

  const readOnly = [({ sql }: { sql: string }) => readOnlyProblem(sql)];
  const policy: Policy = {
    task: `Answer a question about the ${db.name} database with read-only SQL`,
    owner: "data-team",
    allowedTools: ["run_sql", "submit_answer"],
    rules: { run_sql: readOnly, submit_answer: readOnly },
    budgets: { maxSteps: 16, maxToolCalls: opts.maxToolCalls ?? 15, maxCostUsd: opts.maxCostUsd ?? 0.25 },
    maxBlockedCalls: 3,
  };

  const goal = [
    `Database schema:\n\n${opts.schema}`,
    opts.hint ? `Hint: ${opts.hint}` : "",
    opts.outputRules ? `Rules for the final query:\n${opts.outputRules}` : "",
    `Question: ${question}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const res = await runAgent(goal, { model, tools, policy, audit, instructions: INSTRUCTIONS });

  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let costUsd = 0;
  let modelCalls = 0;
  for (const e of audit.entries) {
    if (e.type !== "model_call") continue;
    const u = (e.data as { usage: Usage }).usage;
    modelCalls++;
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;
    usage.cacheReadTokens! += u.cacheReadTokens ?? 0;
    usage.cacheWriteTokens! += u.cacheWriteTokens ?? 0;
    if (!opts.chatModel) costUsd += callCost(modelId, u);
  }

  const final = submitted as { sql: string; result: Result | null } | null;
  return {
    sql: final?.sql ?? null,
    result: final?.result ?? null,
    text: res.finalText,
    status: res.status,
    reason: res.reason,
    costUsd,
    usage,
    modelCalls,
    queries,
    audit,
  };
}
