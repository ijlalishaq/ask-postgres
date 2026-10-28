/**
 * BIRD Mini-Dev (Li et al., 2023; CC BY-SA 4.0), PostgreSQL split, 2026 update.
 *
 * Questions come from the Hugging Face dataset pinned to the release commit. The databases come
 * from the dump layer of the official PostgreSQL image (tag 20261009), fetched straight from the
 * registry so Docker isn't needed. Every file is checked against its published sha256.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const BIRD_DIR = resolve(".data/bird");
export const QUESTIONS = resolve(BIRD_DIR, "mini_dev_postgresql.jsonl");
export const DUMPS = resolve(BIRD_DIR, "dumps");

export const HF_REVISION = "38818fcbc46038129592680c51b2c8b597aac27c";

/** The fixed baseline prompts and the schema text they embed, hashes pinned in BIRD's validator. */
export const BASELINE = resolve(BIRD_DIR, "baseline_postgresql.jsonl");
export const SCHEMA_TEXT = resolve(BIRD_DIR, "schemas_postgresql.json");
const HF_BASE = `https://huggingface.co/datasets/birdsql/bird_mini_dev/resolve/${HF_REVISION}`;
export const FILES: { path: string; url: string; sha256: string }[] = [
  { path: QUESTIONS, url: `${HF_BASE}/data/mini_dev_postgresql.jsonl`, sha256: "ff8b561724d8e643bc906434e9e612cc43a782a385764f1c288ffe82c73cbc2c" },
  { path: BASELINE, url: `${HF_BASE}/baseline_inference/mini_dev_postgresql.jsonl`, sha256: "f745c324fe3ddc6d1f683d9713e9afe480addf59d71e413dfbccc1333eb11dab" },
  { path: SCHEMA_TEXT, url: `${HF_BASE}/baseline_inference/schemas/postgresql.json`, sha256: "32b57c6e29601c6b6da629f38472c63b057279a14c4bb2678a20d4663a1d0799" },
];

export const IMAGE = "3036197201/bird-mini-dev-postgresql";
/** The layer of the amd64 image (tag 20261009) that holds /opt/bird/dumps. */
export const DUMP_LAYER = "sha256:0b89a082050526e9fd97e0402c0322036ad8f3f61de7157ce4812c0b4412f826";

export const DATABASES = [
  "california_schools",
  "card_games",
  "codebase_community",
  "debit_card_specializing",
  "european_football_2",
  "financial",
  "formula_1",
  "student_club",
  "superhero",
  "thrombosis_prediction",
  "toxicology",
] as const;

export type Difficulty = "simple" | "moderate" | "challenging";

export interface Question {
  question_id: number;
  db_id: string;
  question: string;
  evidence: string;
  SQL: string;
  difficulty: Difficulty;
}

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export interface BaselineRow extends Question {
  prompt: string;
}

export function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

/**
 * A fixed sample spread evenly through the file. The questions are grouped by database, so the
 * first N would all come from one or two of them.
 */
export function sample<T>(items: T[], n: number): T[] {
  if (n >= items.length) return items;
  const step = items.length / n;
  return Array.from({ length: n }, (_, i) => items[Math.floor(i * step)]!);
}

export function loadQuestions(path = QUESTIONS): Question[] {
  return readJsonl<Question>(path);
}
