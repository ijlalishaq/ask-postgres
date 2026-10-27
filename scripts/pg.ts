/**
 * A local Postgres for development and the benchmark, using the binaries from embedded-postgres,
 * so nothing needs to be installed system-wide.
 *
 *   pnpm pg init | start | stop | status
 *
 * The cluster lives in .data/pg and listens on localhost:54329. Point DATABASE_URL at any other
 * Postgres to use that instead.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, platform } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PG_DIR = resolve(".data/pg");
export const PG_PORT = 54329;
export const ADMIN_URL = `postgres://postgres@localhost:${PG_PORT}/postgres`;

/** Paths to initdb and pg_ctl from the platform package that embedded-postgres pulls in. */
export async function binaries(): Promise<{ initdb: string; pg_ctl: string }> {
  // The platform package is a dependency of embedded-postgres, so resolve it from there.
  const fromEmbedded = createRequire(createRequire(import.meta.url).resolve("embedded-postgres"));
  const pkg = fromEmbedded.resolve(`@embedded-postgres/${platform()}-${arch()}`);
  return (await import(pathToFileURL(pkg).href)) as { initdb: string; pg_ctl: string };
}

function run(cmd: string, args: string[]): number {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  return r.status ?? 1;
}

async function main(): Promise<void> {
  const action = process.argv[2];
  const bin = await binaries();
  const data = resolve(PG_DIR, "data");
  switch (action) {
    case "init": {
      if (existsSync(data)) return console.log(`already initialised: ${data}`);
      mkdirSync(PG_DIR, { recursive: true });
      // Same encoding and locale as the official BIRD image; text ordering depends on it.
      const code = run(bin.initdb, ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--locale=en_US.utf8"]);
      if (code) process.exit(code);
      writeFileSync(
        resolve(data, "postgresql.auto.conf"),
        [`port = ${PG_PORT}`, "listen_addresses = 'localhost'", "timezone = 'Asia/Hong_Kong'", "shared_buffers = '512MB'", ""].join("\n"),
      );
      return;
    }
    case "start":
      process.exit(run(bin.pg_ctl, ["-D", data, "-l", resolve(PG_DIR, "server.log"), "-w", "start"]));
    case "stop":
      process.exit(run(bin.pg_ctl, ["-D", data, "-w", "stop"]));
    case "status":
      process.exit(run(bin.pg_ctl, ["-D", data, "status"]));
    default:
      console.error("usage: pnpm pg init|start|stop|status");
      process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
