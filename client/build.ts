#!/usr/bin/env bun
/**
 * Build orchestration for the Oxymoron SPA.
 *
 * Builds the React client with Vite → ../public, which the FastAPI server serves
 * as the SPA shell (see app/spa.py). Optionally hand off to the Python server:
 *       bun run build.ts            # build only
 *       bun run build.ts --serve    # build, then start the Python server
 *
 * Run from the client/ directory:  `bun run build.ts`
 */

const serve = process.argv.includes("--serve");

async function run(cmd: string[], cwd?: string): Promise<void> {
  console.log(`\n$ ${cmd.join(" ")}`);
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`\n✗ command failed (exit ${code}): ${cmd.join(" ")}`);
    process.exit(code);
  }
}

// 1. Type-check + bundle the SPA into ../public.
await run(["bunx", "vite", "build"]);
console.log("\n✓ SPA built → ../public");

// 2. (Optional) Hand off to the Python server, which now serves ./public.
if (serve) {
  console.log("\n→ starting Python server (serving ./public)…");
  await run(["./.venv/bin/python3", "app"], "..");
}
