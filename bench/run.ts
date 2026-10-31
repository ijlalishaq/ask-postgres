/**
 * pnpm bench:run --strategy agent --model claude-haiku-5-5 [--limit 20] [--ids 1,2,3] [--concurrency 4]
 *
 * Runs one strategy over the Mini-Dev PostgreSQL questions and appends one line per question to
 * runs/<strategy>--<model>.jsonl. Questions already in the file are skipped, so an interrupted
 * run picks up where it stopped. Scoring is separate (bench:score) and costs nothing.
 */
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { Database, databaseUrl } from "../src/db.js";
import { loadEnv } from "../src/env.js";
import { MODELS } from "../src/pricing.js";
import { introspect, renderSchema } from "../src/schema.js";
import { BASELINE, readJsonl, sample, type BaselineRow } from "./bird.js";
import { benchUrl } from "./env.js";
import { STRATEGIES } from "./strategies.js";

const { values } = parseArgs({
  options: {
    strategy: { type: "string" },
    model: { type: "string", default: "claude-haiku-5-5" },
    limit: { type: "string" },
    ids: { type: "string" },
    concurrency: { type: "string", default: "4" },
    tag: { type: "string" },
  },
});
const strategy = values.strategy ?? "";
const model = values.model!;
if (!STRATEGIES[strategy]) throw new Error(`--strategy must be one of ${Object.keys(STRATEGIES).join(", ")}`);
if (!MODELS.includes(model)) throw new Error(`--model must be one of ${MODELS.join(", ")}`);
loadEnv();

const out = `runs/${strategy}--${model}${values.tag ? `--${values.tag}` : ""}.jsonl`;
mkdirSync("runs", { recursive: true });
const done = new Set(existsSync(out) ? readJsonl<{ question_id: number }>(out).map((r) => r.question_id) : []);

let questions = readJsonl<BaselineRow>(BASELINE);
if (values.ids) {
  const ids = new Set(values.ids.split(",").map(Number));
  questions = questions.filter((q) => ids.has(q.question_id));
}
if (values.limit) questions = sample(questions, Number(values.limit));
const todo = questions.filter((q) => !done.has(q.question_id));

const dbs = new Map<string, Promise<{ db: Database; schema: string }>>();
function contextFor(dbId: string) {
  let c = dbs.get(dbId);
  if (!c) {
    const db = new Database(databaseUrl(benchUrl(), dbId), 8);
    c = introspect(db).then((tables) => ({ db, schema: renderSchema(tables) }));
    dbs.set(dbId, c);
  }
  return c;
}

let finished = 0;
let spent = 0;
async function work(q: BaselineRow): Promise<void> {
  const { db, schema } = await contextFor(q.db_id);
  const t0 = performance.now();
  let row: Record<string, unknown>;
  try {
    const a = await STRATEGIES[strategy]!(q, { db, model, schema });
    row = { question_id: q.question_id, db_id: q.db_id, difficulty: q.difficulty, ...a };
    spent += a.costUsd;
  } catch (err) {
    row = { question_id: q.question_id, db_id: q.db_id, difficulty: q.difficulty, sql: null, error: (err as Error).message };
  }
  row.ms = Math.round(performance.now() - t0);
  appendFileSync(out, JSON.stringify(row) + "\n");
  finished++;
  if (finished % 10 === 0 || finished === todo.length) console.log(`${finished}/${todo.length}  $${spent.toFixed(4)} so far`);
}

const queue = [...todo];
const workers = Math.min(Number(values.concurrency), queue.length);
await Promise.all(
  Array.from({ length: workers }, async () => {
    for (let q = queue.shift(); q; q = queue.shift()) await work(q);
  }),
);
for (const c of dbs.values()) await (await c).db.close();
console.log(`${out}: ${todo.length} new, ${done.size} already there, $${spent.toFixed(4)}`);
