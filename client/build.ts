#!/usr/bin/env bun
/**
 * Build orchestration for the Oxymoron SPA.
 *
 * Phase 1 (now): build the React client with Vite → ../public.
 * Phase 2 (later): once the FastAPI server is wired to serve ./public as the SPA,
 *   uncomment the launch step below to build-then-serve in one command:
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

// 2. (Deferred) Hand off to the Python server. Left as a stub until the FastAPI
//    app is taught to serve ./public. Fill in the real launch command here, e.g.:
//
//        await run(["uv", "run", "uvicorn", "app.main:create_app",
//                   "--factory", "--host", "0.0.0.0", "--port", "8000"], "..");
//
//    or `python -m app`. Do NOT enable until the server-side route exists.
if (serve) {
  console.warn(
    "\n--serve requested, but the Python hand-off is not wired yet.\n" +
      "Edit client/build.ts step 2 once FastAPI serves ./public.",
  );
  // await run(["python", "-m", "app"], "..");
}
