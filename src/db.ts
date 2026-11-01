/**
 * Read-only access to a Postgres database.
 *
 * Every query runs in its own READ ONLY transaction with a statement timeout, over the extended
 * protocol (so a string holding two statements is rejected by the server instead of running both),
 * as a role that only has SELECT. Each layer would stop a write on its own.
 */
import pg from "pg";
import type { RawResult } from "./values.js";

// Hand every value back as the text Postgres sent; values.ts decides how to compare them.
const raw = { getTypeParser: () => (v: string) => v };

/**
 * Rows as arrays (two columns can share a name) over the extended protocol, which refuses a string
 * with more than one statement in it. pg supports queryMode but its type definitions don't list it.
 */
function extended(text: string): pg.QueryArrayConfig {
  return { text, rowMode: "array", queryMode: "extended" } as pg.QueryArrayConfig;
}

export interface QueryOptions {
  timeoutMs?: number;
  /** Refuse queries whose planner estimate is above this (EXPLAIN total cost). */
  maxCost?: number;
  maxRows?: number;
  /** Extra settings for this query's transaction, e.g. { max_parallel_workers_per_gather: "2" }. */
  settings?: Record<string, string>;
}

export class QueryError extends Error {
  constructor(
    message: string,
    readonly kind: "syntax" | "timeout" | "too_expensive" | "error",
  ) {
    super(message);
  }
}

export interface Result extends RawResult {
  columns: string[];
  /** Rows Postgres returned before maxRows was applied. */
  rowCount: number;
  ms: number;
}

export class Database {
  private readonly pool: pg.Pool;

  constructor(
    readonly url: string,
    max = 4,
  ) {
    this.pool = new pg.Pool({ connectionString: url, max, types: raw });
  }

  get name(): string {
    return new URL(this.url).pathname.slice(1);
  }

  async query(sql: string, opts: QueryOptions = {}): Promise<Result> {
    const client = await this.pool.connect();
    const t0 = performance.now();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query(`SET LOCAL statement_timeout = ${Math.round(opts.timeoutMs ?? 30_000)}`);
      for (const [name, value] of Object.entries(opts.settings ?? {})) {
        await client.query("SELECT set_config($1, $2, true)", [name, value]);
      }
      if (opts.maxCost !== undefined) {
        const plan = await client.query(extended(`EXPLAIN (FORMAT JSON) ${sql}`));
        const cost = Number(JSON.parse(plan.rows[0]![0]!)[0].Plan["Total Cost"]);
        if (cost > opts.maxCost) {
          throw new QueryError(`estimated cost ${Math.round(cost)} is over the limit of ${opts.maxCost}; narrow the query`, "too_expensive");
        }
      }
      const res = await client.query(extended(sql));
      const rows = res.rows;
      return {
        columns: res.fields.map((f) => f.name),
        oids: res.fields.map((f) => f.dataTypeID),
        rows: opts.maxRows !== undefined ? rows.slice(0, opts.maxRows) : rows,
        rowCount: rows.length,
        ms: performance.now() - t0,
      };
    } catch (err) {
      if (err instanceof QueryError) throw err;
      const e = err as { code?: string; message?: string };
      // 42xxx is syntax errors and unknown names, except 42501 (permission denied).
      const kind = e.code === "57014" ? "timeout" : e.code?.startsWith("42") && e.code !== "42501" ? "syntax" : "error";
      throw new QueryError(e.message ?? String(err), kind);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Connection URL for one database, given a base URL that points at any database on the server. */
export function databaseUrl(base: string, db: string): string {
  const u = new URL(base);
  u.pathname = `/${db}`;
  return u.toString();
}
