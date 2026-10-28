/** pnpm bench:download: fetches the Mini-Dev questions, baseline prompts and database dumps into .data/bird. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { BIRD_DIR, DUMP_LAYER, DUMPS, FILES, IMAGE, sha256 } from "./bird.js";

async function fetchChecked(url: string, expected: string, headers: Record<string, string> = {}): Promise<Buffer> {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== expected) throw new Error(`${url}: sha256 ${got}, expected ${expected}`);
  return buf;
}

async function registryToken(): Promise<string> {
  const url = `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${IMAGE}:pull`;
  const body = (await (await fetch(url)).json()) as { token: string };
  return body.token;
}

async function main(): Promise<void> {
  mkdirSync(BIRD_DIR, { recursive: true });

  for (const f of FILES) {
    if (existsSync(f.path)) continue;
    writeFileSync(f.path, await fetchChecked(f.url, f.sha256));
    console.log(`-> ${f.path}`);
  }

  if (!existsSync(DUMPS)) {
    console.log("fetching database dumps (227 MB)...");
    const token = await registryToken();
    const layer = await fetchChecked(
      `https://registry-1.docker.io/v2/${IMAGE}/blobs/${DUMP_LAYER}`,
      DUMP_LAYER.slice("sha256:".length),
      { Authorization: `Bearer ${token}` },
    );
    const tgz = resolve(BIRD_DIR, "dumps.tgz");
    writeFileSync(tgz, layer);
    mkdirSync(DUMPS);
    // The layer is a tarball rooted at /; keep only the dump files.
    const r = spawnSync("tar", ["xzf", tgz, "-C", DUMPS, "--strip-components=3", "opt/bird/dumps"], { stdio: "inherit" });
    if (r.status) throw new Error("tar failed");
    rmSync(tgz);
    console.log(`dumps -> ${DUMPS}`);
  }
}

await main();
