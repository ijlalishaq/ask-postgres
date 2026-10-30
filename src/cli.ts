/**
 * pnpm ask "which teams scored most last season?" [--db URL] [--model claude-haiku-5-5] [--hint TEXT]
 * pnpm ask --schema            print the schema text the model sees
 *
 * Connects to DATABASE_URL (or --db), reads the schema from the catalog, and lets the agent
 * answer. Prints the SQL it settled on, the first rows, a one-line answer and what it cost.
 */
import { parseArgs } from "node:util";
import { ask } from "./agent.js";
import { Database } from "./db.js";
import { loadEnv } from "./env.js";
import { formatResult } from "./format.js";
import { MODELS } from "./pricing.js";
import { assertReadOnlyRole } from "./safety.js";
import { introspect, renderSchema } from "./schema.js";

loadEnv();
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: "string" },
    model: { type: "string", default: "claude-haiku-5-5" },
    hint: { type: "string" },
    schema: { type: "boolean", default: false },
    "allow-writable-role": { type: "boolean", default: false },
  },
});

const url = values.db ?? process.env.DATABASE_URL;
if (!url) throw new Error("set DATABASE_URL or pass --db");
if (!MODELS.includes(values.model!)) throw new Error(`--model must be one of ${MODELS.join(", ")}`);

const db = new Database(url);
try {
  await assertReadOnlyRole(db, values["allow-writable-role"]);
  const schema = renderSchema(await introspect(db));
  if (values.schema) {
    console.log(schema);
  } else {
    const question = positionals.join(" ").trim();
    if (!question) throw new Error('usage: pnpm ask "your question"');
    const a = await ask(db, question, { schema, model: values.model, hint: values.hint });
    if (a.sql) {
      console.log(`\n${a.sql}\n`);
      console.log(a.result ? formatResult(a.result) : "(the final query failed)");
    }
    console.log(`\n${a.text || a.reason || "(no answer)"}`);
    console.log(`\n${a.status}, ${a.modelCalls} model calls, ${a.queries} queries, $${a.costUsd.toFixed(4)}`);
  }
} finally {
  await db.close();
}
