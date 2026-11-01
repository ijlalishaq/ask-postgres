/**
 * pnpm bench:check: runs every gold query as the read-only role and checks it executes and
 * returns rows, which the 2026 release manifest says all 500 do. A cheap way to confirm the
 * restore matches the release before spending anything on models.
 *
 * It also runs each gold query a second time with parallel query forced on, to count the
 * answers that depend on the plan (float sums added up in a different order).
 */
import { Database, databaseUrl } from "../src/db.js";
import { sameResult } from "../src/values.js";
import { loadQuestions } from "./bird.js";
import { benchUrl } from "./env.js";

const PARALLEL = {
  max_parallel_workers_per_gather: "4",
  parallel_setup_cost: "0",
  parallel_tuple_cost: "0",
  min_parallel_table_scan_size: "0",
};

const dbs = new Map<string, Database>();
let errors = 0;
let empty = 0;
const unstable: number[] = [];
let slowest = { ms: 0, id: -1 };
for (const q of loadQuestions()) {
  const db = dbs.get(q.db_id) ?? new Database(databaseUrl(benchUrl(), q.db_id));
  dbs.set(q.db_id, db);
  try {
    const r = await db.query(q.SQL, { timeoutMs: 60_000 });
    if (r.rowCount === 0) {
      empty++;
      console.log(`#${q.question_id} ${q.db_id}: no rows`);
    }
    if (r.ms > slowest.ms) slowest = { ms: r.ms, id: q.question_id };
    const p = await db.query(q.SQL, { timeoutMs: 60_000, settings: PARALLEL });
    if (!sameResult(r, p)) unstable.push(q.question_id);
  } catch (err) {
    errors++;
    console.log(`#${q.question_id} ${q.db_id}: ${(err as Error).message}`);
  }
}
for (const db of dbs.values()) await db.close();
console.log(`errors ${errors}, empty ${empty}, slowest #${slowest.id} ${slowest.ms.toFixed(0)} ms`);
console.log(`answers that change under a parallel plan: ${unstable.length}${unstable.length ? ` (${unstable.join(", ")})` : ""}`);
