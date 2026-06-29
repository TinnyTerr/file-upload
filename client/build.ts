/**
 * Bun build orchestration: type-check then produce the production bundle into
 * ../public. Run with `bun run build.ts` (or `bun run build:prod`).
 */
import { spawnSync } from "node:child_process";

function run(cmd: string, args: string[]) {
  const label = [cmd, ...args].join(" ");
  console.log(`\n\x1b[36m▸ ${label}\x1b[0m`);
  const res = spawnSync(cmd, args, { stdio: "inherit", shell: true });
  if (res.status !== 0) {
    console.error(`\x1b[31m✗ failed: ${label}\x1b[0m`);
    process.exit(res.status ?? 1);
  }
}

run("bunx", ["tsc", "-b"]);
run("tsc", ["vite", "build"]);
console.log("\n\x1b[32m✓ Build complete → ../public\x1b[0m");
