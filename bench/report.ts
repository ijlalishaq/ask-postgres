/**
 * pnpm bench:report [results/*.json]
 *
 * Turns scored runs into the tables in the README: execution accuracy with a 95% interval, cost
 * and latency per strategy, and paired comparisons. Two runs over the same questions are compared
 * question by question (how many each solved that the other didn't), with a bootstrap interval on
 * the difference, which is much tighter than comparing two independent accuracies.
 */
import { readdirSync, readFileSync } from "node:fs";

interface Report {
  name: string;
  questions: number;
  correct: number;
  ex: number;
  costPer1kQuestions: number;
  meanSeconds: number;
  meanModelCalls: number;
  meanQueries: number;
  errors: number;
  solved: number[];
}

/** Wilson score interval for a proportion, in percentage points. */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [100 * (c - h), 100 * (c + h)];
}

/** Seeded PRNG so the bootstrap gives the same interval every time. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Paired bootstrap 95% interval on accuracy(a) - accuracy(b), in points, over the shared questions. */
export function pairedDiff(a: boolean[], b: boolean[], iters = 10_000): { diff: number; lo: number; hi: number } {
  const n = a.length;
  const d = a.map((x, i) => Number(x) - Number(b[i]));
  const mean = (100 * d.reduce((s, v) => s + v, 0)) / n;
  const rand = mulberry32(1);
  const samples: number[] = [];
  for (let it = 0; it < iters; it++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += d[Math.floor(rand() * n)]!;
    samples.push((100 * s) / n);
  }
  samples.sort((x, y) => x - y);
  return { diff: mean, lo: samples[Math.floor(0.025 * iters)]!, hi: samples[Math.floor(0.975 * iters)]! };
}

function load(paths: string[]): Report[] {
  return paths.map((p) => JSON.parse(readFileSync(p, "utf8")) as Report);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const paths = args.length
    ? args
    : readdirSync("results")
        .filter((f) => f.endsWith(".json") && !f.includes("pilot") && f !== "oracle.json")
        .map((f) => `results/${f}`);
  const reports = load(paths).sort((x, y) => x.name.localeCompare(y.name));

  console.log("| run | EX | 95% interval | $ / 1k questions | seconds / question | model calls | queries |");
  console.log("|---|---:|---|---:|---:|---:|---:|");
  for (const r of reports) {
    const [lo, hi] = wilson(r.correct, r.questions);
    console.log(
      `| ${r.name} | ${r.ex.toFixed(1)} | ${lo.toFixed(1)} to ${hi.toFixed(1)} | ${r.costPer1kQuestions.toFixed(2)} | ${r.meanSeconds.toFixed(1)} | ${r.meanModelCalls.toFixed(1)} | ${r.meanQueries.toFixed(1)} |`,
    );
  }

  // Every pair over the same question set, question by question.
  console.log("\n| a | b | a only | b only | a - b (points) | 95% interval |");
  console.log("|---|---|---:|---:|---:|---|");
  for (let i = 0; i < reports.length; i++) {
    for (let j = i + 1; j < reports.length; j++) {
      const a = reports[i]!;
      const b = reports[j]!;
      if (a.questions !== b.questions) continue;
      const ids = Array.from({ length: 500 }, (_, k) => k);
      const sa = new Set(a.solved);
      const sb = new Set(b.solved);
      const va = ids.map((k) => sa.has(k));
      const vb = ids.map((k) => sb.has(k));
      const { diff, lo, hi } = pairedDiff(va, vb);
      const aOnly = ids.filter((k) => sa.has(k) && !sb.has(k)).length;
      const bOnly = ids.filter((k) => sb.has(k) && !sa.has(k)).length;
      console.log(`| ${a.name} | ${b.name} | ${aOnly} | ${bOnly} | ${diff.toFixed(1)} | ${lo.toFixed(1)} to ${hi.toFixed(1)} |`);
    }
  }
}
