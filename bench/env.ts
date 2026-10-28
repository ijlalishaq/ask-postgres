import { PG_PORT } from "../scripts/pg.js";

/** The server the benchmark runs on, as the read-only role. Override with BENCH_DATABASE_URL. */
export function benchUrl(): string {
  return process.env.BENCH_DATABASE_URL ?? `postgres://asker@localhost:${PG_PORT}/postgres`;
}
