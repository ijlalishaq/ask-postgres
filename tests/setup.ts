/**
 * Starts a throwaway Postgres cluster (embedded-postgres binaries, temp directory, random port)
 * with a small fixture database and the same read-only role the benchmark uses. Tests get its
 * URL with inject("databaseUrl"). No BIRD download or API key needed.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import type { TestProject } from "vitest/node";
import { binaries } from "../scripts/pg.js";

const FIXTURE = `
CREATE TABLE teams (id int PRIMARY KEY, name text NOT NULL, "Home City" text);
CREATE TABLE players (
  id int PRIMARY KEY,
  team_id int REFERENCES teams (id),
  name text NOT NULL,
  goals int,
  rating real,
  salary numeric(10, 2),
  joined date
);
COMMENT ON COLUMN players.rating IS 'average match rating, 0 to 10';
INSERT INTO teams VALUES (1, 'Harbour FC', 'Portsmouth'), (2, 'Ridge United', 'Leeds');
INSERT INTO players VALUES
  (1, 1, 'Ana', 12, 7.5, 1200.50, '2021-08-01'),
  (2, 1, 'Ben', 3, 6.1, 800.00, '2022-01-15'),
  (3, 2, 'Cleo', 9, 7.5, 1500.00, '2020-07-30'),
  (4, 2, 'Dev', NULL, NULL, NULL, NULL);
CREATE ROLE asker LOGIN;
ALTER ROLE asker SET default_transaction_read_only = on;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO asker;
ANALYZE;
`;

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const bin = await binaries();
  const dir = mkdtempSync(join(tmpdir(), "ask-postgres-test-"));
  const data = join(dir, "data");
  const port = 55000 + Math.floor(Math.random() * 5000);
  const quiet = { stdio: "ignore" as const };
  if (spawnSync(bin.initdb, ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--locale=C"], quiet).status) {
    throw new Error("initdb failed");
  }
  writeFileSync(join(data, "postgresql.auto.conf"), `port = ${port}\nlisten_addresses = 'localhost'\nunix_socket_directories = '${dir}'\n`);
  if (spawnSync(bin.pg_ctl, ["-D", data, "-l", join(dir, "log"), "-w", "start"], quiet).status) throw new Error("pg_ctl start failed");

  const admin = new pg.Client({ connectionString: `postgres://postgres@localhost:${port}/postgres` });
  await admin.connect();
  await admin.query("CREATE DATABASE league");
  await admin.end();
  const league = new pg.Client({ connectionString: `postgres://postgres@localhost:${port}/league` });
  await league.connect();
  await league.query(FIXTURE);
  await league.end();

  project.provide("databaseUrl", `postgres://asker@localhost:${port}/league`);
  return async () => {
    spawnSync(bin.pg_ctl, ["-D", data, "-w", "-m", "fast", "stop"], quiet);
    rmSync(dir, { recursive: true, force: true });
  };
}
