/**
 * pnpm bench:score runs/<name>.jsonl [...]
 *
 * Execution accuracy the way BIRD scores it: run the predicted and the gold query, and count the
 * question as solved when the two results are equal as sets of rows (src/values.ts). Questions
 * missing from a run file, or with no query, count as wrong. Writes results/<name>.json with
 * totals per difficulty and per database, cost, and every miss for review.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { Database, databaseUrl, type Result } from "../src/db.js";
import { formatResult } from "../src/format.js";
import { sameResult } from "../src/values.js";
import { loadQuestions, readJsonl, type Difficulty, type Question } from "./bird.js";
import { benchUrl } from "./env.js";

interface RunRow {
  question_id: number;
  sql: string | null;
  costUsd?: number;
  ms?: number;
  modelCalls?: number;
  queries?: number;
  error?: string;
}

const questions = new Map(loadQuestions().map((q) => [q.question_id, q]));
const dbs = new Map<string, Database>();
const db = (id: string) => dbs.get(id) ?? dbs.set(id, new Database(databaseUrl(benchUrl(), id), 4)).get(id)!;
const goldCache = new Map<number, Promise<Result>>();
const gold = (q: Question) => goldCache.get(q.question_id) ?? goldCache.set(q.question_id, db(q.db_id).query(q.SQL, { timeoutMs: 60_000 })).get(q.question_id)!;

const pct = (n: number, d: number) => (d ? Math.round((1000 * n) / d) / 10 : 0);

async function score(path: string) {
  const rows = readJsonl<RunRow>(path);
  const graded: { q: Question; row: RunRow; ok: boolean; why: string; pred?: Result }[] = [];
  await Promise.all(
    rows.map(async (row) => {
      const q = questions.get(row.question_id);
      if (!q) throw new Error(`unknown question ${row.question_id} in ${path}`);
      if (!row.sql) return graded.push({ q, row, ok: false, why: row.error ? `run error: ${row.error}` : "no query" });
      try {
        // BIRD's evaluator gives each pair 30 seconds.
        const pred = await db(q.db_id).query(row.sql, { timeoutMs: 30_000 });
        const ok = sameResult(pred, await gold(q));
        graded.push({ q, row, ok, why: ok ? "" : "wrong result", pred });
      } catch (err) {
        graded.push({ q, row, ok: false, why: `query error: ${(err as Error).message}` });
      }
    }),
  );
  graded.sort((a, b) => a.q.question_id - b.q.question_id);

  const by = <K extends string>(key: (g: (typeof graded)[number]) => K) => {
    const out: Record<string, { n: number; correct: number; ex: number }> = {};
    for (const g of graded) {
      const k = key(g);
      out[k] ??= { n: 0, correct: 0, ex: 0 };
      out[k].n++;
      out[k].correct += Number(g.ok);
    }
    for (const v of Object.values(out)) v.ex = pct(v.correct, v.n);
    return out;
  };

  const n = graded.length;
  const correct = graded.filter((g) => g.ok).length;
  const cost = graded.reduce((s, g) => s + (g.row.costUsd ?? 0), 0);
  const mean = (f: (r: RunRow) => number | undefined) => graded.reduce((s, g) => s + (f(g.row) ?? 0), 0) / Math.max(1, n);
  const name = basename(path, ".jsonl");
  const report = {
    name,
    questions: n,
    correct,
    ex: pct(correct, n),
    byDifficulty: by((g) => g.q.difficulty as Difficulty),
    byDatabase: by((g) => g.q.db_id),
    costUsd: cost,
    costPer1kQuestions: (1000 * cost) / Math.max(1, n),
    meanSeconds: mean((r) => r.ms) / 1000,
    meanModelCalls: mean((r) => r.modelCalls),
    meanQueries: mean((r) => r.queries),
    errors: graded.filter((g) => g.why.startsWith("query error") || g.why.startsWith("run error")).length,
    solved: graded.filter((g) => g.ok).map((g) => g.q.question_id),
    misses: graded
      .filter((g) => !g.ok)
      .map((g) => ({
        question_id: g.q.question_id,
        db_id: g.q.db_id,
        difficulty: g.q.difficulty,
        question: g.q.question,
        evidence: g.q.evidence,
        why: g.why,
        predicted: g.row.sql,
        gold: g.q.SQL,
        predictedResult: g.pred ? formatResult(g.pred, 5) : undefined,
      })),
  };
  mkdirSync("results", { recursive: true });
  writeFileSync(`results/${name}.json`, JSON.stringify(report, null, 2) + "\n");
  const d = report.byDifficulty;
  console.log(
    `${name}: EX ${report.ex}% (${correct}/${n})  simple ${d.simple?.ex ?? "-"} moderate ${d.moderate?.ex ?? "-"} challenging ${d.challenging?.ex ?? "-"}  ` +
      `$${report.costPer1kQuestions.toFixed(2)}/1k questions  ${report.meanSeconds.toFixed(1)}s each`,
  );
}

const paths = process.argv.slice(2);
if (!paths.length) throw new Error("usage: pnpm bench:score runs/<name>.jsonl [...]");
for (const p of paths) await score(p);
for (const d of dbs.values()) await d.close();
